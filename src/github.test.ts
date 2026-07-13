import { describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from './errors.js';
import { GitHubClient, type GitHubResponseInfo, parseNextLink } from './github.js';

describe('GitHub Link-header parsing', () => {
  it('extracts the rel="next" URL', () => {
    const header =
      '<https://api.github.com/repositories/1/pulls/1/comments?page=2>; rel="next", ' +
      '<https://api.github.com/repositories/1/pulls/1/comments?page=5>; rel="last"';
    expect(parseNextLink(header)).toBe(
      'https://api.github.com/repositories/1/pulls/1/comments?page=2',
    );
  });

  it('returns null when there is no next relation', () => {
    expect(parseNextLink('<https://api.github.com/x?page=5>; rel="last"')).toBeNull();
    expect(parseNextLink('')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink(undefined)).toBeNull();
  });
});

describe('GitHub client URL construction', () => {
  it('appends paths to the trimmed base and serializes query params', () => {
    const client = new GitHubClient({ apiUrl: 'https://api.github.com/', token: 't' });

    expect(client.url('/repos/o/r/pulls/1/comments', { per_page: 100, page: 2 })).toBe(
      'https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=2',
    );
  });

  it('defaults to the public GitHub API base', () => {
    const client = new GitHubClient({ token: 't' });
    expect(client.url('/user')).toBe('https://api.github.com/user');
  });

  it('honors GITHUB_API_URL / enterprise bases including /api/v3', () => {
    const client = new GitHubClient({ apiUrl: 'https://ghe.example.com/api/v3', token: 't' });
    expect(client.url('/repos/o/r/pulls/1')).toBe(
      'https://ghe.example.com/api/v3/repos/o/r/pulls/1',
    );
  });
});

describe('GitHub pull request metadata', () => {
  it('GETs the PR with Bearer auth and the GitHub Accept header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          head: { ref: 'feature', sha: 'headsha' },
          base: { ref: 'main', sha: 'basesha' },
          title: 'Add retry helper',
          body: 'Adds a retry helper for the cart route.',
        }),
      ),
    );
    const client = new GitHubClient({ token: 'gh-token', fetchImpl });

    const pr = await client.getPullRequest('octo', 'repo', 12);

    expect(pr.head).toEqual({ ref: 'feature', sha: 'headsha' });
    expect(pr.base.ref).toBe('main');
    expect(pr.title).toBe('Add retry helper');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/octo/repo/pulls/12');
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer gh-token',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('GETs the authenticated user', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 99, login: 'review-bot' })));
    const client = new GitHubClient({ token: 't', fetchImpl });

    await expect(client.getCurrentUser()).resolves.toEqual({ id: 99, login: 'review-bot' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/user');
  });
});

describe('GitHub pagination with mocked fetch', () => {
  it('follows Link rel="next" across pages and sends auth headers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), {
          headers: {
            link: '<https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }])));

    const client = new GitHubClient({ token: 'gh-token', fetchImpl });

    await expect(client.listReviewComments('o', 'r', 1)).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/o/r/pulls/1/comments?per_page=100',
    );
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=2',
    );
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer gh-token',
      Accept: 'application/vnd.github+json',
    });
  });

  it('paginates issue comments at the /issues/{n}/comments endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ id: 5, body: 'summary' }])));
    const client = new GitHubClient({ token: 't', fetchImpl });

    await expect(client.listIssueComments('o', 'r', 7)).resolves.toEqual([
      { id: 5, body: 'summary' },
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/o/r/issues/7/comments?per_page=100',
    );
  });

  it('throws a typed GitHubApiError on a non-array paginated payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1 })));
    const client = new GitHubClient({ token: 't', fetchImpl });

    await expect(client.listReviewComments('o', 'r', 1)).rejects.toThrow(
      'returned a non-array paginated response',
    );
  });
});

describe('GitHub write endpoints', () => {
  it('POSTs a batched review with commit_id and inline comments', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 555 })));
    const client = new GitHubClient({ token: 't', fetchImpl });

    const payload = {
      commit_id: 'headsha',
      event: 'COMMENT',
      comments: [{ path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'bug' }],
    };
    await expect(client.createReview('o', 'r', 3, payload)).resolves.toMatchObject({ id: 555 });

    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls/3/reviews');
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(payload));
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('POSTs a summary issue comment', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 77, body: 'hello' })));
    const client = new GitHubClient({ token: 't', fetchImpl });

    await expect(client.createIssueComment('o', 'r', 12, 'hello')).resolves.toMatchObject({
      id: 77,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/issues/12/comments');
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ body: 'hello' }));
  });

  it('PATCHes an issue comment at the comment-scoped endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 77, body: 'updated' })));
    const client = new GitHubClient({ token: 't', fetchImpl });

    await expect(client.updateIssueComment('o', 'r', 77, 'updated')).resolves.toMatchObject({
      id: 77,
      body: 'updated',
    });
    // Updates target /issues/comments/{id}, NOT the issue-scoped collection.
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/issues/comments/77');
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ body: 'updated' }));
  });
});

describe('GitHub client error handling', () => {
  it('throws a typed GitHubApiError with status and body on failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('denied', { status: 403, statusText: 'Forbidden' }));
    const client = new GitHubClient({ token: 't', fetchImpl });

    await expect(client.getPullRequest('o', 'r', 1)).rejects.toMatchObject({
      name: 'GitHubApiError',
      status: 403,
      responseBody: 'denied',
      method: 'GET',
    });
  });

  it('surfaces a 422 off-diff review error as a typed error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Unprocessable Entity' }), {
        status: 422,
        statusText: 'Unprocessable Entity',
      }),
    );
    const client = new GitHubClient({ token: 't', fetchImpl });

    await expect(
      client.createReview('o', 'r', 1, { commit_id: 'x', comments: [] }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('reports a timeout as an aborted typed error', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const client = new GitHubClient({ token: 't', fetchImpl, requestTimeout: 1 });

    await expect(client.getCurrentUser()).rejects.toMatchObject({
      name: 'GitHubApiError',
      timeout: true,
    });
  });
});

describe('GitHub client onResponse instrumentation hook', () => {
  it('reports each response with method, path, url, status, and content length', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1, login: 'bot' }), {
        status: 200,
        headers: { 'content-length': '42' },
      }),
    );
    const seen: GitHubResponseInfo[] = [];
    const client = new GitHubClient({
      token: 't',
      fetchImpl,
      onResponse: (info) => seen.push(info),
    });

    await client.getCurrentUser();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'GET',
      path: '/user',
      url: 'https://api.github.com/user',
      status: 200,
      responseContentLength: 42,
    });
  });

  it('reports the failing response before throwing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('denied', { status: 403, statusText: 'Forbidden' }));
    const seen: GitHubResponseInfo[] = [];
    const client = new GitHubClient({
      token: 't',
      fetchImpl,
      onResponse: (info) => seen.push(info),
    });

    await expect(client.getCurrentUser()).rejects.toThrow(GitHubApiError);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', status: 403 });
  });

  it('reports one response per page when paginating', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), {
          headers: {
            link: '<https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }])));
    const seen: GitHubResponseInfo[] = [];
    const client = new GitHubClient({
      token: 't',
      fetchImpl,
      onResponse: (info) => seen.push(info),
    });

    await client.listReviewComments('o', 'r', 1);
    expect(seen).toHaveLength(2);
    expect(seen.every((info) => info.status === 200)).toBe(true);
  });

  it('treats a present-but-blank content-length header as absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1, login: 'b' }), {
        headers: { 'content-length': ' ' },
      }),
    );
    const seen: GitHubResponseInfo[] = [];
    const client = new GitHubClient({
      token: 't',
      fetchImpl,
      onResponse: (info) => seen.push(info),
    });

    await client.getCurrentUser();
    expect(seen[0].responseContentLength).toBeUndefined();
  });
});
