import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { formatUsageLine } from '../src/cli.js';
import {
  parseArgs,
  resolveConfig,
  validateConfig,
  type Config,
  type Severity,
  type ThinkingLevel,
} from '../src/config.js';
import { ConfigError, GitLabApiError, ReviewerError, formatError } from '../src/errors.js';
import { getMergeDiffArguments } from '../src/git.js';
import { GitLabClient } from '../src/gitlab.js';
import { filterDiff, runReview, type AgentLike, type ReviewUsage } from '../src/pi-reviewer.js';
import { postGeneratedComments } from '../src/posting.js';
import {
  appendFingerprintMarkers,
  buildGeneratedComments,
  buildPayload,
  createDiagnosticContext,
  diagnosticChannels,
  extractDiffHunkContext,
  extractExistingFingerprints,
  fingerprints,
  normalizeBody,
  parseReviewMarkdown,
  parseReviewMarkdownWithWarnings,
  traceDiagnostic,
  type DiagnosticContext,
  type GeneratedComment,
} from '../src/review.js';

describe('config env defaults', () => {
  it('resolves GitLab CI defaults deterministically', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '123',
      CI_MERGE_REQUEST_IID: '45',
      CI_SERVER_HOST: 'gitlab.example.com',
      GITLAB_TOKEN: 'private-token',
      PI_API_KEY: 'api-key',
    });

    expect(cfg).toMatchObject({
      project: '123',
      mr: '45',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 'private-token',
      gitlabAuthHeader: 'PRIVATE-TOKEN',
      model: 'anthropic/claude-sonnet-4-5',
      minSeverity: 'info',
      thinkingLevel: 'off',
      postingMode: 'direct',
      reviewFile: 'pi-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
    });
  });

  it('prefers CLI values over environment defaults', () => {
    const cfg = resolveConfig(
      [
        '--project',
        'cli-project',
        '--mr',
        '9',
        '--gitlab-url',
        'https://cli.example.com/',
        '--gitlab-token',
        'cli-token',
        '--api-key',
        'cli-key',
        '--min-severity',
        'warn',
      ],
      {
        CI_PROJECT_ID: 'env-project',
        CI_MERGE_REQUEST_IID: '8',
        CI_SERVER_URL: 'https://env.example.com',
        GITLAB_TOKEN: 'env-token',
        PI_API_KEY: 'env-key',
      },
    );

    expect(cfg).toMatchObject({
      project: 'cli-project',
      mr: '9',
      gitlabUrl: 'https://cli.example.com',
      gitlabToken: 'cli-token',
      gitlabAuthHeader: 'PRIVATE-TOKEN',
      apiKey: 'cli-key',
      minSeverity: 'warn',
    });
  });

  it('uses CI_JOB_TOKEN with JOB-TOKEN header when no private token is set', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gitlab.example.com',
      CI_JOB_TOKEN: 'job-token',
      PI_API_KEY: 'key',
    });

    expect(cfg).toMatchObject({
      gitlabToken: 'job-token',
      gitlabAuthHeader: 'JOB-TOKEN',
    });
  });
});

describe('typed errors', () => {
  it('throws ConfigError for invalid config', () => {
    expect(() => validateConfig(resolveConfig([], {}))).toThrow(ConfigError);
  });

  it('formats typed errors with code and hint', () => {
    const error = new ReviewerError('review failed', { hint: 'check logs' });
    expect(formatError(error)).toBe('[REVIEWER_ERROR] review failed\nHint: check logs');
  });
});

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
    expect(init.body).toBe(JSON.stringify(payload));
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

describe('postGeneratedComments strategies', () => {
  const fresh: GeneratedComment = {
    comment: { file: 'a.ts', line: 1, side: 'RIGHT', severity: 'info', body: 'fresh' },
    fingerprints: { primary: 'p1', secondary: 's1' },
    duplicate: false,
    payload: {
      body: 'fresh <!-- pi-reviewer:fingerprint-primary:p1 -->',
      position: {
        position_type: 'text',
        base_sha: 'b',
        start_sha: 's',
        head_sha: 'h',
        old_path: 'a.ts',
        new_path: 'a.ts',
        new_line: 1,
      },
    },
  };
  const dup: GeneratedComment = {
    ...fresh,
    comment: { ...fresh.comment, body: 'dup' },
    duplicate: true,
  };

  function clientWith(fetchImpl: ReturnType<typeof vi.fn>) {
    return new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });
  }

  it('returns zero with no API calls when every comment is a duplicate', async () => {
    const fetchImpl = vi.fn();
    const result = await postGeneratedComments(clientWith(fetchImpl), 'p', '1', [dup]);
    expect(result).toEqual({ posted: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('direct mode posts one discussion per fresh comment', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: 'd1' }))));
    const result = await postGeneratedComments(
      clientWith(fetchImpl),
      'p',
      '1',
      [fresh, dup, fresh],
      'direct',
    );
    expect(result).toEqual({ posted: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain('/merge_requests/1/discussions');
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
  });

  const draftA: GeneratedComment = {
    ...fresh,
    fingerprints: { primary: 'aaaa', secondary: 'aabb' },
  };
  const draftB: GeneratedComment = {
    ...fresh,
    fingerprints: { primary: 'bbbb', secondary: 'bbcc' },
  };

  type RouteHandler = (init: RequestInit | undefined) => Response;

  function routeFetch(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
    return vi.fn((url: string, init?: RequestInit) => {
      for (const [pattern, handler] of Object.entries(routes)) {
        const [method, path] = pattern.split(' ');
        if ((init?.method ?? 'GET') === method && url.includes(path)) {
          return Promise.resolve(handler(init));
        }
      }
      throw new Error(`Unrouted: ${init?.method ?? 'GET'} ${url}`);
    });
  }

  it('draft mode: cleans no orphans, creates N drafts, bulk-publishes once', async () => {
    let createdId = 100;
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'GET /discussions': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'POST /draft_notes/bulk_publish': () => new Response(null, { status: 204 }),
      'POST /draft_notes': () => {
        const id = createdId++;
        return new Response(JSON.stringify({ id, author_id: 1, note: 'x' }));
      },
    });

    const result = await postGeneratedComments(
      clientWith(fetchImpl),
      'p',
      '1',
      [draftA, draftB, dup],
      'draft',
    );

    expect(result).toEqual({
      posted: 2,
      drafts: { abandoned: 0, created: 2, deletedPrePublish: 0, published: 2 },
    });
    const calls = fetchImpl.mock.calls.map(
      (call) => `${call[1]?.method ?? 'GET'} ${call[0].replace(/.*\/api\/v4/, '')}`,
    );
    expect(
      calls.filter((c) => c.startsWith('POST') && c.includes('/draft_notes/bulk_publish')),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (c) => c.startsWith('POST') && c.includes('/draft_notes') && !c.includes('bulk_publish'),
      ),
    ).toHaveLength(2);
  });

  it('draft mode: deletes orphan drafts authored by the current user before creating new ones', async () => {
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () =>
        new Response(
          JSON.stringify([
            { id: 7, author_id: 1, note: 'orphan-mine' },
            { id: 8, author_id: 2, note: 'orphan-others' },
          ]),
          { headers: { 'x-next-page': '' } },
        ),
      'DELETE /draft_notes': () => new Response(null, { status: 204 }),
      'GET /discussions': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'POST /draft_notes/bulk_publish': () => new Response(null, { status: 204 }),
      'POST /draft_notes': () => new Response(JSON.stringify({ id: 100, author_id: 1, note: 'x' })),
    });

    const result = await postGeneratedComments(clientWith(fetchImpl), 'p', '1', [draftA], 'draft');

    expect(result.drafts).toMatchObject({ abandoned: 1, created: 1, published: 1 });
    const deletes = fetchImpl.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toContain('/draft_notes/7');

    // Orphan cleanup must complete before any new draft is created.
    const firstOrphanDelete = fetchImpl.mock.calls.findIndex(
      (c) => c[1]?.method === 'DELETE' && c[0].includes('/draft_notes/7'),
    );
    const firstCreate = fetchImpl.mock.calls.findIndex(
      (c) =>
        c[1]?.method === 'POST' && c[0].includes('/draft_notes') && !c[0].includes('bulk_publish'),
    );
    expect(firstOrphanDelete).toBeGreaterThanOrEqual(0);
    expect(firstCreate).toBeGreaterThan(firstOrphanDelete);
  });

  it('draft mode: skips bulk_publish when every draft is race-deleted', async () => {
    let createdId = 100;
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'POST /draft_notes': () =>
        new Response(JSON.stringify({ id: createdId++, author_id: 1, note: 'x' })),
      'GET /discussions': () =>
        new Response(
          JSON.stringify([
            {
              notes: [
                {
                  body: 'collide <!-- pi-reviewer:fingerprint-primary:aaaa --> <!-- pi-reviewer:fingerprint-secondary:aabb -->',
                },
                {
                  body: 'collide <!-- pi-reviewer:fingerprint-primary:bbbb --> <!-- pi-reviewer:fingerprint-secondary:bbcc -->',
                },
              ],
            },
          ]),
          { headers: { 'x-next-page': '' } },
        ),
      'DELETE /draft_notes': () => new Response(null, { status: 204 }),
    });

    const result = await postGeneratedComments(
      clientWith(fetchImpl),
      'p',
      '1',
      [draftA, draftB],
      'draft',
    );

    expect(result.posted).toBe(0);
    expect(result.drafts).toMatchObject({ created: 2, deletedPrePublish: 2, published: 0 });
    expect(fetchImpl.mock.calls.filter((c) => c[0].includes('bulk_publish'))).toHaveLength(0);
  });

  it('draft mode: self-heals partial drafts when a create call fails mid-flight', async () => {
    let createsSeen = 0;
    let listsSeen = 0;
    const successfulDraftId = 100;
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () => {
        listsSeen += 1;
        // 1st list: orphan cleanup at run start, empty.
        // 2nd list: self-heal cleanup after the failure, returns the draft
        // we managed to create before the sibling worker failed.
        const body =
          listsSeen === 1 ? [] : [{ id: successfulDraftId, author_id: 1, note: 'partial' }];
        return new Response(JSON.stringify(body), { headers: { 'x-next-page': '' } });
      },
      'POST /draft_notes': () => {
        createsSeen += 1;
        if (createsSeen === 1) {
          return new Response(JSON.stringify({ id: successfulDraftId, author_id: 1, note: 'ok' }));
        }
        return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
      },
      'DELETE /draft_notes': () => new Response(null, { status: 204 }),
    });

    await expect(
      postGeneratedComments(clientWith(fetchImpl), 'p', '1', [draftA, draftB], 'draft'),
    ).rejects.toBeInstanceOf(GitLabApiError);

    // Self-heal ran a second list-and-delete that swept the partial draft.
    expect(listsSeen).toBe(2);
    const deletes = fetchImpl.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toContain(`/draft_notes/${successfulDraftId}`);
    // We never attempted to publish anything.
    expect(fetchImpl.mock.calls.filter((c) => c[0].includes('bulk_publish'))).toHaveLength(0);
  });

  it('draft mode: deletes drafts whose fingerprints collide with newly-published discussions', async () => {
    let createdId = 100;
    const createdToFp = new Map<number, string>();
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'POST /draft_notes/bulk_publish': () => new Response(null, { status: 204 }),
      'POST /draft_notes': (init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const id = createdId++;
        const fp = body.body.includes('aaaa') ? 'aaaa' : 'bbbb';
        createdToFp.set(id, fp);
        return new Response(JSON.stringify({ id, author_id: 1, note: body.body }));
      },
      'GET /discussions': () =>
        new Response(
          JSON.stringify([
            {
              notes: [
                {
                  body: 'collision <!-- pi-reviewer:fingerprint-primary:aaaa --> <!-- pi-reviewer:fingerprint-secondary:aabb -->',
                },
              ],
            },
          ]),
          { headers: { 'x-next-page': '' } },
        ),
      'DELETE /draft_notes': () => new Response(null, { status: 204 }),
    });

    const aWithFp: GeneratedComment = {
      ...draftA,
      payload: { ...draftA.payload, body: 'collision text aaaa' },
    };
    const bWithFp: GeneratedComment = {
      ...draftB,
      payload: { ...draftB.payload, body: 'unique text bbbb' },
    };

    const result = await postGeneratedComments(
      clientWith(fetchImpl),
      'p',
      '1',
      [aWithFp, bWithFp],
      'draft',
    );

    expect(result.drafts).toMatchObject({ created: 2, deletedPrePublish: 1, published: 1 });
    expect(result.posted).toBe(1);
    const deletes = fetchImpl.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    const deletedId = Number(deletes[0][0].match(/draft_notes\/(\d+)/)?.[1]);
    expect(createdToFp.get(deletedId)).toBe('aaaa');
  });
});

describe('runReview pipeline', () => {
  const minimalConfig: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'tok',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    apiKey: 'key',
    reviewFile: 'pi-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    cwd: '/tmp',
  };

  const sampleDiff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    ' line1',
    '+added',
    ' line2',
    '',
  ].join('\n');

  function makeAssistant(
    text: string,
    usage: Partial<AssistantMessage['usage']> & {
      cost?: Partial<AssistantMessage['usage']['cost']>;
    } = {},
  ): AssistantMessage {
    return {
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        totalTokens:
          usage.totalTokens ??
          (usage.input ?? 0) +
            (usage.output ?? 0) +
            (usage.cacheRead ?? 0) +
            (usage.cacheWrite ?? 0),
        cost: {
          input: usage.cost?.input ?? 0,
          output: usage.cost?.output ?? 0,
          cacheRead: usage.cost?.cacheRead ?? 0,
          cacheWrite: usage.cost?.cacheWrite ?? 0,
          total: usage.cost?.total ?? 0,
        },
      },
    } as AssistantMessage;
  }

  function fakeAgent(messages: AssistantMessage[]): AgentLike {
    let listener: ((event: AgentEvent) => void | Promise<void>) | undefined;
    return {
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        if (!listener) return;
        for (const message of messages) {
          await listener({ type: 'message_end', message });
        }
        await listener({ type: 'agent_end', messages });
      },
    };
  }

  it('builds the same merge diff arguments used for review and comment positions', () => {
    expect(getMergeDiffArguments('develop')).toEqual([
      'refs/remotes/origin/develop...HEAD',
      '--unified=20',
      '--',
    ]);
  });

  it('filterDiff drops noise files and reports them as skipped', () => {
    const noisy = [
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    const result = filterDiff(noisy);
    expect(result.skippedFiles).toEqual(['package-lock.json']);
    expect(result.diff).toContain('src/a.ts');
    expect(result.diff).not.toContain('package-lock.json');
  });

  it('accumulates usage across multiple assistant messages and writes pi-review.md', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const messages = [
      makeAssistant('partial thought', {
        input: 100,
        output: 25,
        cacheRead: 10,
        cacheWrite: 5,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
      }),
      makeAssistant('Final review summary.', {
        input: 50,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.0005, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.0035 },
      }),
    ];

    const usage = await runReview(
      { ...minimalConfig, cwd },
      {
        cwd,
        diff: sampleDiff,
        createAgent: () => fakeAgent(messages),
      },
    );

    expect(usage.model).toBe('anthropic/claude-sonnet-4-5');
    expect(usage.tokens).toEqual({
      input: 150,
      output: 65,
      cacheRead: 10,
      cacheWrite: 5,
      total: 230,
    });
    expect(usage.cost.input).toBeCloseTo(0.0015, 10);
    expect(usage.cost.output).toBeCloseTo(0.005, 10);
    expect(usage.cost.cacheRead).toBeCloseTo(0.0001, 10);
    expect(usage.cost.cacheWrite).toBeCloseTo(0.0002, 10);
    expect(usage.cost.total).toBeCloseTo(0.0068, 10);

    const written = await readFile(join(cwd, 'pi-review.md'), 'utf8');
    expect(written).toBe('Final review summary.');
  });

  it('passes the systemPrompt with minSeverity rule and tools scoped to cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured = vi.fn();
    const messages = [makeAssistant('ok', { input: 1, output: 1 })];

    await runReview(
      { ...minimalConfig, cwd, minSeverity: 'warn' },
      {
        cwd,
        diff: sampleDiff,
        createAgent: (params) => {
          captured(params);
          return fakeAgent(messages);
        },
      },
    );

    expect(captured).toHaveBeenCalledTimes(1);
    const params = captured.mock.calls[0][0];
    expect(params.systemPrompt).toContain('Only report CRITICAL and WARN issues');
    expect(Array.isArray(params.tools)).toBe(true);
    expect(params.tools.length).toBeGreaterThan(0);
    expect(params.thinkingLevel).toBe('off');
  });

  it('forwards config.thinkingLevel to the agent factory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured = vi.fn();
    const messages = [makeAssistant('ok', { input: 1, output: 1 })];

    await runReview(
      { ...minimalConfig, cwd, thinkingLevel: 'high' },
      {
        cwd,
        diff: sampleDiff,
        createAgent: (params) => {
          captured(params);
          return fakeAgent(messages);
        },
      },
    );

    expect(captured.mock.calls[0][0].thinkingLevel).toBe('high');
  });

  it('throws ReviewerError when the agent returns no text', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const messages = [makeAssistant('', { input: 1, output: 0 })];

    await expect(
      runReview(
        { ...minimalConfig, cwd },
        {
          cwd,
          diff: sampleDiff,
          createAgent: () => fakeAgent(messages),
        },
      ),
    ).rejects.toBeInstanceOf(ReviewerError);
  });
});

describe('pi-review parsing', () => {
  it('parses inline comment blocks with severity and body normalization', () => {
    const markdown = [
      'Review summary',
      '== Inline Comments ==',
      '🟡 src/app.ts:10 (RIGHT)',
      'Please simplify this branch.',
      '',
      '🔴 `src/legacy.ts:5` - LEFT',
      'remove dead code <!-- pi-reviewer:fingerprint-primary:abcd -->',
    ].join('\n');

    expect(parseReviewMarkdown(markdown)).toEqual([
      {
        file: 'src/app.ts',
        line: 10,
        side: 'RIGHT',
        severity: 'warn',
        body: 'Please simplify this branch.',
      },
      {
        file: 'src/legacy.ts',
        line: 5,
        side: 'LEFT',
        severity: 'critical',
        body: 'remove dead code',
      },
    ]);
  });

  it('parses JSON comment fences and legacy markers', () => {
    const markdown = [
      '```json',
      '{"comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix this"}]}',
      '```',
      '<!-- pi-reviewer-comment {"file":"src/b.ts","old_line":9,"body":"Old side"} -->',
    ].join('\n');

    expect(parseReviewMarkdown(markdown)).toEqual([
      { file: 'src/a.ts', line: 3, side: 'RIGHT', severity: 'info', body: 'Fix this' },
      { file: 'src/b.ts', line: 9, side: 'LEFT', severity: 'info', body: 'Old side' },
    ]);
  });

  it('parses JSON comment fences whose bodies contain fenced code blocks', () => {
    const payload = {
      comments: [
        {
          file: 'config/bot/review.yml',
          line: 8,
          side: 'RIGHT',
          severity: 'CRITICAL',
          body: 'Use this syntax:\n\n```yaml\n- if: $CI_PIPELINE_SOURCE == "web"\n```',
        },
      ],
    };
    const markdown = ['```json', JSON.stringify(payload, null, 2), '```'].join('\n');

    expect(parseReviewMarkdown(markdown)).toEqual([
      {
        file: 'config/bot/review.yml',
        line: 8,
        side: 'RIGHT',
        severity: 'critical',
        body: 'Use this syntax:\n\n```yaml\n- if: $CI_PIPELINE_SOURCE == "web"\n```',
      },
    ]);
  });

  it('emits warnings for text before the first parseable inline header', () => {
    const markdown = [
      '== Inline Comments ==',
      'I should be ignored',
      '🔵 src/file.ts:1 (RIGHT)',
      'Valid comment',
    ].join('\n');

    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.comments).toHaveLength(1);
    expect(result.warnings).toEqual([
      'Ignored text in the inline comments section before the first parseable comment header.',
    ]);
  });
});

describe('diff hunk context', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' line1',
    '-line2',
    '+line2-updated',
    ' line3',
    '@@ -10,2 +11,3 @@',
    ' line10',
    '+line11-new',
    ' line12',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -4,2 +4,2 @@',
    '-old-b',
    '+new-b',
  ].join('\n');

  it('returns the matching hunk for right-side lines', () => {
    const hunk = extractDiffHunkContext(diff, 'src/a.ts', 11, 'RIGHT');
    expect(hunk).toContain('@@ -10,2 +11,3 @@');
    expect(hunk).toContain('+line11-new');
  });

  it('returns the matching hunk for left-side lines', () => {
    const hunk = extractDiffHunkContext(diff, 'src/a.ts', 2, 'LEFT');
    expect(hunk).toContain('@@ -1,3 +1,4 @@');
    expect(hunk).toContain('-line2');
  });

  it('returns deterministic fallback when no matching hunk exists', () => {
    expect(extractDiffHunkContext(diff, 'src/unknown.ts', 1, 'RIGHT')).toBe(
      'src/unknown.ts:RIGHT:1',
    );
  });
});

describe('fingerprints and duplicate detection', () => {
  it('normalizes comment bodies consistently', () => {
    const a = 'Fix   this\n\n<!-- pi-reviewer:fingerprint-primary:abcd -->';
    const b = 'Fix this';

    expect(normalizeBody(a)).toBe(normalizeBody(b));
  });

  it('produces stable fingerprints for semantically same bodies', () => {
    const comment = {
      file: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      severity: 'info' as const,
      body: 'Fix   this',
    };
    const sameComment = { ...comment, body: 'Fix this' };

    expect(fingerprints(comment, 'hunk-context')).toEqual(
      fingerprints(sameComment, 'hunk-context'),
    );
  });

  it('changes fingerprints when hunk context changes', () => {
    const comment = {
      file: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      severity: 'info' as const,
      body: 'Fix this',
    };
    const fpA = fingerprints(comment, 'hunk-a');
    const fpB = fingerprints(comment, 'hunk-b');

    expect(fpA.primary).not.toBe(fpB.primary);
    expect(fpA.secondary).not.toBe(fpB.secondary);
  });

  it('extracts existing markers and marks generated duplicates', () => {
    const baseComment = {
      file: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      severity: 'info' as const,
      body: 'Please rename this variable',
    };
    const hunk = '@@ -1,1 +1,2 @@\n old\n+new';
    const existing = fingerprints(baseComment, hunk);
    const existingSet = extractExistingFingerprints([
      { notes: [{ body: appendFingerprintMarkers('Existing', existing) }] },
    ]);

    const generated = buildGeneratedComments(
      [baseComment, baseComment],
      ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', hunk].join('\n'),
      { base_sha: 'base', start_sha: 'start', head_sha: 'head' },
      existingSet,
    );

    expect(generated).toHaveLength(2);
    expect(generated[0].duplicate).toBe(true);
    expect(generated[1].duplicate).toBe(true);
  });
});

describe('payload generation', () => {
  const refs = { base_sha: 'base', start_sha: 'start', head_sha: 'head' };

  it('builds right-side payloads with new_line', () => {
    const payload = buildPayload(
      { file: 'src/file.ts', line: 42, side: 'RIGHT', severity: 'info', body: 'Body' },
      'Body',
      refs,
    );

    expect(payload).toEqual({
      body: 'Body',
      position: {
        position_type: 'text',
        base_sha: 'base',
        start_sha: 'start',
        head_sha: 'head',
        old_path: 'src/file.ts',
        new_path: 'src/file.ts',
        new_line: 42,
      },
    });
  });

  it('builds left-side payloads with old_line', () => {
    const payload = buildPayload(
      { file: 'src/file.ts', line: 5, side: 'LEFT', severity: 'warn', body: 'Body' },
      'Body',
      refs,
    );

    expect(payload.position).toMatchObject({
      old_path: 'src/file.ts',
      new_path: 'src/file.ts',
      old_line: 5,
    });
    expect(payload.position.new_line).toBeUndefined();
  });
});

describe('validateConfig', () => {
  const minimalConfig: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'tok',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    apiKey: 'key',
    reviewFile: 'pi-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    cwd: '/tmp',
  };

  it('throws listing all missing required fields', () => {
    expect(() => validateConfig({ ...minimalConfig, project: '', mr: '' })).toThrow(
      '--project, --mr',
    );
  });

  it('throws on invalid min-severity', () => {
    expect(() => validateConfig({ ...minimalConfig, minSeverity: 'bad' as Severity })).toThrow(
      '--min-severity must be one of',
    );
  });

  it('throws on invalid thinking level', () => {
    expect(() =>
      validateConfig({
        ...minimalConfig,
        thinkingLevel: 'bogus' as ThinkingLevel,
      }),
    ).toThrow('--thinking must be one of: off, minimal, low, medium, high, xhigh');
  });

  it('accepts every documented thinking level', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
      expect(() => validateConfig({ ...minimalConfig, thinkingLevel: level })).not.toThrow();
    }
  });
});

describe('thinking level resolution', () => {
  it('defaults to off when neither flag nor env is set', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      PI_API_KEY: 'k',
    });
    expect(cfg.thinkingLevel).toBe('off');
  });

  it('reads from PI_REVIEWER_THINKING_LEVEL env var', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      PI_API_KEY: 'k',
      PI_REVIEWER_THINKING_LEVEL: 'medium',
    });
    expect(cfg.thinkingLevel).toBe('medium');
  });

  it('lower-cases and trims env values before validation', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      PI_API_KEY: 'k',
      PI_REVIEWER_THINKING_LEVEL: '  HIGH  ',
    });
    expect(cfg.thinkingLevel).toBe('high');
  });

  it('lets --thinking override PI_REVIEWER_THINKING_LEVEL', () => {
    const cfg = resolveConfig(['--thinking', 'xhigh'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      PI_API_KEY: 'k',
      PI_REVIEWER_THINKING_LEVEL: 'low',
    });
    expect(cfg.thinkingLevel).toBe('xhigh');
  });

  it('rejects invalid values via validateConfig', () => {
    const cfg = resolveConfig(['--thinking', 'sometimes'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      PI_API_KEY: 'k',
    });
    expect(() => validateConfig(cfg)).toThrow('--thinking must be one of');
  });
});

describe('posting mode resolution', () => {
  it('defaults to direct when neither flag nor env is set', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      PI_API_KEY: 'k',
    });
    expect(cfg.postingMode).toBe('direct');
  });

  it('reads from PI_REVIEWER_POSTING_MODE env var and trims case', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      PI_API_KEY: 'k',
      PI_REVIEWER_POSTING_MODE: '  DRAFT  ',
    });
    expect(cfg.postingMode).toBe('draft');
  });

  it('lets --posting-mode override the env value', () => {
    const cfg = resolveConfig(['--posting-mode', 'direct'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      PI_API_KEY: 'k',
      PI_REVIEWER_POSTING_MODE: 'draft',
    });
    expect(cfg.postingMode).toBe('direct');
  });

  it('validateConfig rejects unknown posting modes', () => {
    const cfg = resolveConfig(['--posting-mode', 'bogus'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      PI_API_KEY: 'k',
    });
    expect(() => validateConfig(cfg)).toThrow('--posting-mode must be one of');
  });
});

describe('parseArgs', () => {
  it('parses --key=value inline syntax', () => {
    expect(parseArgs(['--project=123'])).toMatchObject({ project: '123' });
  });

  it('parses -h and -v short flags', () => {
    expect(parseArgs(['-h'])).toMatchObject({ help: true });
    expect(parseArgs(['-v'])).toMatchObject({ version: true });
  });

  it('throws on missing value for non-boolean flag', () => {
    expect(() => parseArgs(['--project'])).toThrow('Missing value for --project');
  });

  it('parses --dry-run and --no-post as booleans', () => {
    expect(parseArgs(['--dry-run', '--no-post'])).toMatchObject({
      dryRun: true,
      noPost: true,
    });
  });
});

describe('diagnostics_channel instrumentation', () => {
  const diagnosticConfig: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'tok',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    apiKey: 'key',
    reviewFile: 'pi-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: false,
    cwd: '/tmp',
  };

  it('publishes tracing channel lifecycle events with safe context', async () => {
    const events: Array<{ type: string; message: DiagnosticContext }> = [];
    const onStart = (message: DiagnosticContext) => events.push({ type: 'start', message });
    const onAsyncEnd = (message: DiagnosticContext) => events.push({ type: 'asyncEnd', message });

    diagnosticChannels.run.start.subscribe(onStart);
    diagnosticChannels.run.asyncEnd.subscribe(onAsyncEnd);
    try {
      const context = createDiagnosticContext('run', diagnosticConfig, 'run-1');
      await expect(
        traceDiagnostic(diagnosticChannels.run, context, async (activeContext) => {
          activeContext.generated = 2;
          activeContext.newComments = 1;
          return 'ok';
        }),
      ).resolves.toBe('ok');
    } finally {
      diagnosticChannels.run.start.unsubscribe(onStart);
      diagnosticChannels.run.asyncEnd.unsubscribe(onAsyncEnd);
    }

    expect(events.map((event) => event.type)).toEqual(['start', 'asyncEnd']);
    expect(events[0].message).toMatchObject({
      version: 1,
      runId: 'run-1',
      phase: 'run',
      project: 'proj',
      mr: '1',
      gitlabUrl: 'https://gitlab.example.com',
      dryRun: true,
    });
    expect(events[0].message).not.toHaveProperty('gitlabToken');
    expect(events[0].message).not.toHaveProperty('apiKey');
    expect(events[1].message).toMatchObject({ generated: 2, newComments: 1 });
    expect(events[1].message.completedAt).toEqual(expect.any(String));
    expect(events[1].message.durationMs).toEqual(expect.any(Number));
  });

  it('adds sanitized error details to failed traces', async () => {
    const errors: DiagnosticContext[] = [];
    const onError = (message: DiagnosticContext) => errors.push(message);

    diagnosticChannels.run.error.subscribe(onError);
    try {
      const context = createDiagnosticContext('run', diagnosticConfig, 'run-error');
      await expect(
        traceDiagnostic(diagnosticChannels.run, context, async () => {
          throw new ConfigError('bad config');
        }),
      ).rejects.toThrow('bad config');
    } finally {
      diagnosticChannels.run.error.unsubscribe(onError);
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].errorInfo).toMatchObject({
      name: 'ConfigError',
      message: 'bad config',
      code: 'CONFIG_ERROR',
    });
  });
});

describe('OpenTelemetry bridge', () => {
  interface RecordedAttribute {
    key: string;
    value: string | number | boolean;
  }
  interface RecordedSpan {
    name: string;
    attributes: RecordedAttribute[];
    status?: { code: number; message?: string };
    exceptions: Array<{ name?: string; message: string }>;
    ended: boolean;
    parent?: RecordedSpan;
  }

  function createFakeRuntime() {
    const spans: RecordedSpan[] = [];
    const shutdown = vi.fn(async () => undefined);

    const makeSpan = (name: string, parent: RecordedSpan | undefined): RecordedSpan => {
      const span: RecordedSpan = {
        name,
        attributes: [],
        exceptions: [],
        ended: false,
        parent,
      };
      spans.push(span);
      return span;
    };

    const SPAN_KEY = Symbol('parent-span');
    const tracer = {
      startSpan(name: string, _opts?: unknown, ctx?: unknown): RecordedSpan {
        const parent =
          ctx && typeof ctx === 'object' && SPAN_KEY in (ctx as Record<symbol, unknown>)
            ? ((ctx as Record<symbol, unknown>)[SPAN_KEY] as RecordedSpan)
            : undefined;
        const span = makeSpan(name, parent);
        return Object.assign(span, {
          setAttribute(key: string, value: string | number | boolean) {
            span.attributes.push({ key, value });
          },
          setStatus(status: { code: number; message?: string }) {
            span.status = status;
          },
          recordException(exception: { name?: string; message: string }) {
            span.exceptions.push(exception);
          },
          end() {
            span.ended = true;
          },
        });
      },
    };

    const api = {
      trace: {
        getTracer: () => tracer,
        setSpan: (_ctx: unknown, span: RecordedSpan) => ({ [SPAN_KEY]: span }),
      },
      context: { active: () => ({}) },
      SpanKind: { INTERNAL: 1 },
      SpanStatusCode: { ERROR: 2 },
    };

    return { runtime: { api, shutdown }, spans, shutdown };
  }

  async function runWithBridge(
    work: (ctx: DiagnosticContext) => Promise<void>,
    runId = 'run-otel',
  ): Promise<ReturnType<typeof createFakeRuntime>> {
    const { startOtelBridge } = await import('../src/otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime as unknown as Parameters<typeof startOtelBridge>[0] extends infer T
        ? T extends { runtime?: infer R }
          ? R
          : never
        : never,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });
    expect(bridge).not.toBeNull();

    const config: Config = {
      project: 'proj',
      mr: '1',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 't',
      gitlabAuthHeader: 'PRIVATE-TOKEN',
      model: 'anthropic/claude-sonnet-4-5',
      minSeverity: 'info',
      thinkingLevel: 'off',
      postingMode: 'direct',
      apiKey: 'k',
      reviewFile: 'pi-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
      cwd: '/tmp',
    };

    const runContext = createDiagnosticContext('run', config, runId);
    try {
      await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
        await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async (ctx) => {
          await work(ctx);
        });
      });
    } catch {
      // Swallow — error-path tests assert on captured spans instead.
    } finally {
      await bridge?.shutdown();
    }
    return fake;
  }

  it('is false unless GITLAB_REVIEW_OTEL is explicitly opted in', async () => {
    const { isOtelEnabled } = await import('../src/otel.js');
    expect(isOtelEnabled({})).toBe(false);
    expect(isOtelEnabled({ GITLAB_REVIEW_OTEL: '0' })).toBe(false);
    expect(isOtelEnabled({ GITLAB_REVIEW_OTEL: 'yes' })).toBe(false);
    expect(isOtelEnabled({ GITLAB_REVIEW_OTEL: '1' })).toBe(true);
    expect(isOtelEnabled({ GITLAB_REVIEW_OTEL: 'true' })).toBe(true);
  });

  it('returns null when disabled without touching the runtime', async () => {
    const { startOtelBridge } = await import('../src/otel.js');
    const fake = createFakeRuntime();
    const result = await startOtelBridge({ runtime: fake.runtime, env: {} });
    expect(result).toBeNull();
    expect(fake.spans).toHaveLength(0);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('opens an invoke_workflow span per run and parents phase spans under it', async () => {
    const { spans } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });

    expect(spans.map((s) => s.name)).toEqual([
      'invoke_workflow gitlab-review',
      'invoke_agent pi-reviewer',
    ]);
    const [root, reviewer] = spans;
    expect(reviewer.parent).toBe(root);
    expect(root.ended).toBe(true);
    expect(reviewer.ended).toBe(true);
  });

  it('stamps gen_ai.* attributes on reviewer.run from DiagnosticUsage', async () => {
    const { spans } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 1200, output: 340, cacheRead: 50, cacheWrite: 10, total: 1600 },
        cost: { input: 0.012, output: 0.034, cacheRead: 0.001, cacheWrite: 0.002, total: 0.049 },
      };
    });
    const reviewer = spans.find((s) => s.name === 'invoke_agent pi-reviewer');
    const attrs = Object.fromEntries(reviewer!.attributes.map((a) => [a.key, a.value]));
    expect(attrs).toMatchObject({
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
      'gen_ai.response.model': 'claude-sonnet-4-5',
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'pi-reviewer',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 340,
      'gen_ai.usage.cache_read.input_tokens': 50,
      'gen_ai.usage.cache_creation.input_tokens': 10,
      'gen_ai.usage.cost.total_usd': 0.049,
    });
  });

  it('records exceptions and ERROR status on rejected phases', async () => {
    const { startOtelBridge } = await import('../src/otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });

    const config: Config = {
      project: 'proj',
      mr: '1',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 't',
      gitlabAuthHeader: 'PRIVATE-TOKEN',
      model: 'anthropic/claude-sonnet-4-5',
      minSeverity: 'info',
      thinkingLevel: 'off',
      postingMode: 'direct',
      apiKey: 'k',
      reviewFile: 'pi-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
      cwd: '/tmp',
    };
    const ctx = createDiagnosticContext('reviewer.run', config, 'run-error');
    await expect(
      traceDiagnostic(diagnosticChannels.runReviewer, ctx, async () => {
        throw new ReviewerError('boom');
      }),
    ).rejects.toThrow('boom');
    await bridge?.shutdown();

    const reviewer = fake.spans.find((s) => s.name === 'invoke_agent pi-reviewer');
    expect(reviewer?.exceptions).toEqual([
      expect.objectContaining({ name: 'ReviewerError', message: 'boom' }),
    ]);
    expect(reviewer?.status).toEqual({ code: 2, message: 'boom' });
    expect(reviewer?.ended).toBe(true);
  });

  it('awaits runtime.shutdown when the bridge stops', async () => {
    const { startOtelBridge } = await import('../src/otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });
    await bridge?.shutdown();
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('dry-run and no-post flags', () => {
  it('resolveConfig sets dryRun from --dry-run', () => {
    const cfg = resolveConfig([
      '--dry-run',
      '--project',
      'p',
      '--mr',
      '1',
      '--gitlab-url',
      'https://gl.example.com',
      '--gitlab-token',
      't',
      '--api-key',
      'k',
    ]);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.noPost).toBe(false);
  });

  it('resolveConfig sets noPost from --no-post', () => {
    const cfg = resolveConfig([
      '--no-post',
      '--project',
      'p',
      '--mr',
      '1',
      '--gitlab-url',
      'https://gl.example.com',
      '--gitlab-token',
      't',
      '--api-key',
      'k',
    ]);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.noPost).toBe(true);
  });
});

function makeUsage(overrides: Partial<ReviewUsage['tokens']> = {}): ReviewUsage {
  return {
    model: 'anthropic/claude-sonnet-4-5',
    tokens: {
      input: overrides.input ?? 0,
      output: overrides.output ?? 0,
      cacheRead: overrides.cacheRead ?? 0,
      cacheWrite: overrides.cacheWrite ?? 0,
      total: overrides.total ?? 0,
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0533 },
  };
}

describe('formatUsageLine', () => {
  it('sums input, cacheRead, and cacheWrite as billable input volume', () => {
    const usage = makeUsage({ input: 35, cacheRead: 10000, cacheWrite: 298, output: 1476 });
    const line = formatUsageLine(usage);
    expect(line).toBe(
      'Review usage: 10,333 in (10,000 cached) / 1,476 out tokens — $0.0533 (anthropic/claude-sonnet-4-5)',
    );
  });

  it('omits the cached hint when cacheRead is zero', () => {
    const usage = makeUsage({ input: 200, output: 50 });
    expect(formatUsageLine(usage)).toBe(
      'Review usage: 200 in / 50 out tokens — $0.0533 (anthropic/claude-sonnet-4-5)',
    );
  });

  it('still counts cacheWrite when cacheRead is zero', () => {
    const usage = makeUsage({ input: 100, cacheWrite: 500, output: 25 });
    expect(formatUsageLine(usage)).toBe(
      'Review usage: 600 in / 25 out tokens — $0.0533 (anthropic/claude-sonnet-4-5)',
    );
  });
});
