import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import { createPlatform } from '../platform.js';
import type { ReviewComment } from '../types.js';
import { GitLabPlatform } from './gitlab.js';

/** Minimal but complete Config for constructing a GitLabPlatform. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    project: 'group/repo',
    mr: '7',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'secret-token',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    reviewDepth: 'single',
    apiKey: 'k',
    reviewFile: 'gitlab-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: '/tmp',
    skills: [],
    refreshGitSkills: false,
    ...overrides,
  };
}

/**
 * Routes GitLab API requests by method + path suffix so a single mock backs a
 * whole platform interaction. Records every call for assertions.
 */
function routedFetch(): { fetchImpl: ReturnType<typeof vi.fn>; calls: Request[] } {
  const calls: Request[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push(new Request(url, { method }));
    if (method === 'GET' && url.endsWith('/merge_requests/7')) {
      return new Response(
        JSON.stringify({ source_branch: 'feature', target_branch: 'main', title: 'Add X' }),
      );
    }
    if (method === 'GET' && url.includes('/versions')) {
      return new Response(
        JSON.stringify([
          { base_commit_sha: 'base1', start_commit_sha: 'start1', head_commit_sha: 'head1' },
        ]),
        { headers: { 'x-next-page': '' } },
      );
    }
    if (method === 'GET' && url.includes('/discussions')) {
      return new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } });
    }
    if (method === 'POST' && url.includes('/discussions')) {
      return new Response(JSON.stringify({ id: 100 }));
    }
    if (method === 'POST' && url.includes('/notes')) {
      return new Response(JSON.stringify({ id: 42, body: 'x' }));
    }
    return new Response('not found', { status: 404 });
  });
  return { fetchImpl, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitLabPlatform', () => {
  it('createPlatform returns a GitLabPlatform (factory placeholder)', () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(createPlatform(makeConfig())).toBeInstanceOf(GitLabPlatform);
  });

  it('getMergeRequest fetches the MR and returns its branches/title', async () => {
    const { fetchImpl } = routedFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const platform = new GitLabPlatform(makeConfig());

    const mr = await platform.getMergeRequest();

    expect(mr).toMatchObject({ source_branch: 'feature', target_branch: 'main', title: 'Add X' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/7',
    );
  });

  it('getRefs maps the latest version SHAs onto DiffRefs', async () => {
    const { fetchImpl } = routedFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const platform = new GitLabPlatform(makeConfig());

    const refs = await platform.getRefs();

    expect(refs).toEqual({ base_sha: 'base1', start_sha: 'start1', head_sha: 'head1' });
  });

  it('lastResponse captures the most recent HTTP response after a read', async () => {
    const { fetchImpl } = routedFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const platform = new GitLabPlatform(makeConfig());

    expect(platform.lastResponse()).toBeUndefined();
    await platform.getMergeRequest();

    const last = platform.lastResponse();
    expect(last?.method).toBe('GET');
    expect(last?.status).toBe(200);
    expect(last?.url).toContain('/merge_requests/7');
  });

  it('buildComments delegates to the GitLab payload builder', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const platform = new GitLabPlatform(makeConfig());
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
    ].join('\n');
    const comments: ReviewComment[] = [
      { file: 'a.ts', line: 2, side: 'RIGHT', severity: 'warn', confidence: 'high', body: 'note' },
    ];

    const generated = platform.buildComments(
      comments,
      diff,
      {
        base_sha: 'b',
        start_sha: 's',
        head_sha: 'h',
      },
      new Set(),
    );

    expect(generated).toHaveLength(1);
    const payload = generated[0].payload as {
      position: { position_type: string; new_line?: number };
    };
    expect(payload.position.position_type).toBe('text');
    expect(payload.position.new_line).toBe(2);
    expect(generated[0].duplicate).toBe(false);
  });

  it('postComments (direct) posts one discussion per fresh comment', async () => {
    const { fetchImpl, calls } = routedFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const platform = new GitLabPlatform(makeConfig());

    const result = await platform.postComments(
      [
        {
          comment: {
            file: 'a.ts',
            line: 1,
            side: 'RIGHT',
            severity: 'warn',
            confidence: 'high',
            body: 'x',
          },
          fingerprints: { primary: 'p', secondary: 's' },
          duplicate: false,
          payload: { body: 'x', position: { position_type: 'text' } },
        },
      ],
      'direct',
    );

    expect(result.posted).toBe(1);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/7/discussions',
    );
  });

  it('upsertSummary creates a new summary note when none exists', async () => {
    const { fetchImpl, calls } = routedFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const platform = new GitLabPlatform(makeConfig());

    const result = await platform.upsertSummary('## summary', [], {});

    expect(result).toEqual({ action: 'created', noteId: 42 });
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/notes'));
    expect(post?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/7/notes',
    );
  });
});
