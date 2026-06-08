import { describe, expect, it, vi } from 'vitest';
import { GitLabApiError } from './errors.js';
import { GitLabClient, type GitLabResponseInfo } from './gitlab.js';

describe('GitLab client URL construction', () => {
  it('builds API v4 URLs and query strings from trimmed base URL', () => {
    const client = new GitLabClient({ gitlabUrl: 'https://gitlab.example.com/', token: 't' });

    expect(
      client.url('/projects/group%2Frepo/merge_requests/10/discussions', {
        page: 2,
        per_page: 100,
        include_resolved: false,
      }),
    ).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/10/discussions?page=2&per_page=100&include_resolved=false',
    );
  });

  it('encodes project path and MR IID in endpoint helpers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ source_branch: 'feature', target_branch: 'main' })),
      );
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await client.getMergeRequest('group/subgroup/repo', '12');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Fsubgroup%2Frepo/merge_requests/12',
    );
  });
});

describe('GitLab pagination with mocked fetch', () => {
  it('follows x-next-page deterministically and sends auth header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), { headers: { 'x-next-page': '2' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 2 }]), { headers: { 'x-next-page': '' } }),
      );

    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 'job-token',
      authHeader: 'JOB-TOKEN',
      fetchImpl,
    });

    await expect(client.paginate('/items')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain('per_page=100&page=1');
    expect(fetchImpl.mock.calls[1][0]).toContain('per_page=100&page=2');
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      'JOB-TOKEN': 'job-token',
      Accept: 'application/json',
    });
  });

  it('throws typed GitLabApiError on API failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('denied', {
        status: 403,
        statusText: 'Forbidden',
      }),
    );
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.request('/items')).rejects.toThrow(GitLabApiError);
  });

  it('fails when paginated payload is not an array', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 1 }), { headers: { 'x-next-page': '' } }),
      );
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.paginate('/items')).rejects.toThrow(
      'returned a non-array paginated response',
    );
  });

  it('fails on invalid x-next-page values', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ id: 1 }]), { headers: { 'x-next-page': '1' } }),
      );
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.paginate('/items')).rejects.toThrow('invalid x-next-page header: 1');
  });
});

describe('GitLab client onResponse instrumentation hook', () => {
  it('reports each response with method, path, url, status, and content length', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ source_branch: 'f', target_branch: 'main' }), {
        status: 200,
        headers: { 'content-length': '42' },
      }),
    );
    const seen: GitLabResponseInfo[] = [];
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
      onResponse: (info) => seen.push(info),
    });

    await client.getMergeRequest('group/repo', '7');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'GET',
      path: '/projects/group%2Frepo/merge_requests/7',
      url: 'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/7',
      status: 200,
      responseContentLength: 42,
    });
  });

  it('reports the failing response before throwing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('denied', { status: 403, statusText: 'Forbidden' }));
    const seen: GitLabResponseInfo[] = [];
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
      onResponse: (info) => seen.push(info),
    });

    await expect(client.request('/items')).rejects.toThrow(GitLabApiError);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', status: 403 });
  });

  it('reports one response per page when paginating', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), { headers: { 'x-next-page': '2' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 2 }]), { headers: { 'x-next-page': '' } }),
      );
    const seen: GitLabResponseInfo[] = [];
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
      onResponse: (info) => seen.push(info),
    });

    await client.paginate('/items');
    expect(seen).toHaveLength(2);
    expect(seen.every((info) => info.status === 200)).toBe(true);
  });

  it('omits responseContentLength when the content-length header is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1 })));
    const seen: GitLabResponseInfo[] = [];
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
      onResponse: (info) => seen.push(info),
    });

    await client.request('/user');
    expect(seen[0].responseContentLength).toBeUndefined();
  });

  it('treats a present-but-blank content-length header as absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), {
        headers: { 'content-length': ' ' },
      }),
    );
    const seen: GitLabResponseInfo[] = [];
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
      onResponse: (info) => seen.push(info),
    });

    await client.request('/user');
    // A blank header must not be reported as a real body size of 0.
    expect(seen[0].responseContentLength).toBeUndefined();
  });
});

describe('GitLab draft notes endpoints', () => {
  it('GETs /user with auth header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 42 })));
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.getCurrentUser()).resolves.toEqual({ id: 42 });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://gitlab.example.com/api/v4/user');
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      'PRIVATE-TOKEN': 't',
      Accept: 'application/json',
    });
  });

  it('paginates draft notes with encoded project and MR IID', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 1, author_id: 7, note: 'a' }]), {
        headers: { 'x-next-page': '' },
      }),
    );
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.listDraftNotes('group/repo', '12')).resolves.toEqual([
      { id: 1, author_id: 7, note: 'a' },
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/12/draft_notes?per_page=100&page=1',
    );
  });

  it('POSTs a draft note with a JSON body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 9, author_id: 7, note: 'x' })));
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    const payload = { body: 'x', position: { position_type: 'text' } };
    await expect(client.createDraftNote('group/repo', '12', payload)).resolves.toMatchObject({
      id: 9,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/12/draft_notes',
    );
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ note: 'x', position: { position_type: 'text' } }));
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('DELETEs a draft note by id and tolerates 204 responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.deleteDraftNote('group/repo', '12', 9)).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/12/draft_notes/9',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('PUTs to publish a single draft note by id and tolerates 204 responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.publishDraftNote('group/repo', '12', 9)).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/12/draft_notes/9/publish',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('PUT');
  });

  it('POSTs to bulk_publish and tolerates 204 responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.bulkPublishDraftNotes('group/repo', '12')).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/12/draft_notes/bulk_publish',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
  });
});

describe('GitLab merge request notes endpoints', () => {
  it('POSTs a non-positional MR note with a JSON body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 77, body: 'hello' })));
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.createMergeRequestNote('group/repo', '12', 'hello')).resolves.toMatchObject(
      { id: 77 },
    );

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/12/notes',
    );
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ body: 'hello' }));
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('PUTs an MR note update at the note ID', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 77, body: 'updated' })));
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(
      client.updateMergeRequestNote('group/repo', '12', 77, 'updated'),
    ).resolves.toMatchObject({ id: 77, body: 'updated' });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/12/notes/77',
    );
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ body: 'updated' }));
  });
});
