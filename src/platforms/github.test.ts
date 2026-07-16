import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../errors.js';
import { extractExistingFingerprints } from '../fingerprints.js';
import { findExistingReviewedCommitSha, findExistingSummaryNote } from '../posting.js';
import { extractPriorThreads } from '../prior-threads.js';
import { extractOpenBotFindings } from '../summary-carryover.js';
import type { DiffRefs, ReviewComment } from '../types.js';
import {
  buildGitHubComments,
  buildGitHubReviewPayload,
  GitHubPlatform,
  type GitHubReviewCommentPayload,
  normalizeGitHubDiscussions,
  parseGitHubPullNumber,
  parseGitHubRepository,
} from './github.js';

const DIFF = [
  'diff --git a/src/index.ts b/src/index.ts',
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const old = 2;',
  '+const b = 2;',
  '+const c = 3;',
  ' const d = 4;',
].join('\n');

const REFS: DiffRefs = { base_sha: 'base', start_sha: 'base', head_sha: 'head-sha' };

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    file: 'src/index.ts',
    line: 3,
    side: 'RIGHT',
    severity: 'warn',
    confidence: 'high',
    body: 'fix: guard the null case',
    ...overrides,
  };
}

describe('buildGitHubReviewPayload', () => {
  it('maps an added line to line=newLine, side=RIGHT', () => {
    // Line 3 in the new file is `+const b = 2;` (an added line).
    const payload = buildGitHubReviewPayload(comment({ line: 3, side: 'RIGHT' }), 'body', DIFF);
    expect(payload).toEqual({ path: 'src/index.ts', body: 'body', line: 3, side: 'RIGHT' });
  });

  it('maps a removed line to line=oldLine, side=LEFT', () => {
    // Old line 2 is `-const old = 2;` (a removed line).
    const payload = buildGitHubReviewPayload(comment({ line: 2, side: 'LEFT' }), 'body', DIFF);
    expect(payload).toEqual({ path: 'src/index.ts', body: 'body', line: 2, side: 'LEFT' });
  });

  it('maps a context line to RIGHT/newLine regardless of the finding side', () => {
    // New line 1 (` const a = 1;`) is an unchanged context line adjacent to the
    // change. GitHub's API prescribes RIGHT for context lines, so both sides map
    // to the same RIGHT/new-line position.
    const right = buildGitHubReviewPayload(comment({ line: 1, side: 'RIGHT' }), 'body', DIFF);
    expect(right).toEqual({ path: 'src/index.ts', body: 'body', line: 1, side: 'RIGHT' });
    const left = buildGitHubReviewPayload(comment({ line: 1, side: 'LEFT' }), 'body', DIFF);
    expect(left).toEqual({ path: 'src/index.ts', body: 'body', line: 1, side: 'RIGHT' });
  });

  it('drops a context line beyond GitHub 3-line hunk context (guards batch 422)', () => {
    // A hunk whose only change is at new line 7-8; our local diff carries wide
    // (--unified=20) context, so new line 1 is a valid line in OUR diff but 6 rows
    // from the nearest change — outside GitHub's 3-line PR diff, which would 422
    // the whole batched review. It must be dropped (null); a context line within
    // 3 rows of the change is still placed on RIGHT.
    const farDiff = [
      'diff --git a/src/far.ts b/src/far.ts',
      '--- a/src/far.ts',
      '+++ b/src/far.ts',
      '@@ -1,10 +1,11 @@',
      ' line1',
      ' line2',
      ' line3',
      ' line4',
      ' line5',
      ' line6',
      '-old7',
      '+new7',
      '+new8',
      ' line9',
      ' line10',
    ].join('\n');
    const far = buildGitHubReviewPayload(
      comment({ file: 'src/far.ts', line: 1, side: 'RIGHT' }),
      'body',
      farDiff,
    );
    expect(far).toBeNull();
    const near = buildGitHubReviewPayload(
      comment({ file: 'src/far.ts', line: 5, side: 'RIGHT' }),
      'body',
      farDiff,
    );
    expect(near).toEqual({ path: 'src/far.ts', body: 'body', line: 5, side: 'RIGHT' });
  });

  it('returns null for a line outside the diff (guards GitHub 422)', () => {
    expect(buildGitHubReviewPayload(comment({ line: 999 }), 'body', DIFF)).toBeNull();
    expect(buildGitHubReviewPayload(comment({ file: 'other.ts' }), 'body', DIFF)).toBeNull();
  });
});

describe('buildGitHubComments', () => {
  it('builds a placed payload with the footer and fingerprint markers', () => {
    const [generated] = buildGitHubComments([comment()], DIFF, REFS, new Set());
    const payload = generated.payload as GitHubReviewCommentPayload;
    expect(payload.line).toBe(3);
    expect(payload.side).toBe('RIGHT');
    expect(payload.body).toContain('fix: guard the null case');
    expect(payload.body).toContain('for commit head-sha');
    expect(payload.body).toContain('code-review:fingerprint-primary');
    expect(generated.duplicate).toBe(false);
  });

  it('marks a finding whose fingerprint already exists as a duplicate', () => {
    const [first] = buildGitHubComments([comment()], DIFF, REFS, new Set());
    const [dup] = buildGitHubComments(
      [comment()],
      DIFF,
      REFS,
      new Set([first.fingerprints.primary]),
    );
    expect(dup.duplicate).toBe(true);
  });

  it('yields a null payload for an off-diff finding', () => {
    const [generated] = buildGitHubComments([comment({ line: 999 })], DIFF, REFS, new Set());
    expect(generated.payload).toBeNull();
    expect(generated.duplicate).toBe(false);
  });
});

describe('normalizeGitHubDiscussions', () => {
  it('threads review comments by in_reply_to_id and keeps arrival order', () => {
    const discussions = normalizeGitHubDiscussions(
      [
        { id: 1, body: 'bot finding', path: 'src/index.ts', line: 3, side: 'RIGHT' },
        { id: 2, body: 'human reply', path: 'src/index.ts', in_reply_to_id: 1 },
        { id: 3, body: 'other', path: 'src/other.ts', line: 5, side: 'RIGHT' },
      ],
      [],
    );
    expect(discussions).toHaveLength(2);
    expect(discussions[0].notes.map((n) => n.id)).toEqual([1, 2]);
    expect(discussions[0].notes[0].position).toMatchObject({
      new_path: 'src/index.ts',
      new_line: 3,
    });
  });

  it('maps a LEFT comment onto the old side', () => {
    const [discussion] = normalizeGitHubDiscussions(
      [{ id: 1, body: 'x', path: 'src/index.ts', line: 2, side: 'LEFT' }],
      [],
    );
    expect(discussion.notes[0].position).toEqual({
      old_path: 'src/index.ts',
      new_path: 'src/index.ts',
      old_line: 2,
    });
  });

  it('turns each issue comment into a single-note discussion', () => {
    const discussions = normalizeGitHubDiscussions(
      [],
      [
        { id: 10, body: 'summary here' },
        { id: 11, body: 'chatter' },
      ],
    );
    expect(discussions).toHaveLength(2);
    expect(discussions[0].notes).toEqual([{ id: 10, body: 'summary here' }]);
  });

  it('marks notes resolved when their id is in the resolved set', () => {
    const discussions = normalizeGitHubDiscussions(
      [
        { id: 1, body: 'resolved finding', path: 'src/a.ts', line: 3, side: 'RIGHT' },
        { id: 2, body: 'reply', path: 'src/a.ts', in_reply_to_id: 1 },
        { id: 3, body: 'open finding', path: 'src/b.ts', line: 4, side: 'RIGHT' },
      ],
      [],
      new Set([1, 2]),
    );
    // The resolved thread's notes are both flagged; the open thread stays false.
    expect(discussions[0].notes.map((n) => n.resolved)).toEqual([true, true]);
    expect(discussions[1].notes.map((n) => n.resolved)).toEqual([false]);
  });

  it('defaults notes to unresolved when no resolved set is passed', () => {
    const [discussion] = normalizeGitHubDiscussions(
      [{ id: 1, body: 'x', path: 'src/a.ts', line: 3, side: 'RIGHT' }],
      [],
    );
    expect(discussion.notes[0].resolved).toBe(false);
  });

  it('feeds the shared fingerprint / summary / prior-thread helpers unchanged', () => {
    // Build a real bot comment body (footer + fingerprint markers) via the payload builder.
    const [generated] = buildGitHubComments([comment()], DIFF, REFS, new Set());
    const botBody = (generated.payload as GitHubReviewCommentPayload).body;

    const discussions = normalizeGitHubDiscussions(
      [
        { id: 1, body: botBody, path: 'src/index.ts', line: 3, side: 'RIGHT' },
        { id: 2, body: 'please fix', path: 'src/index.ts', in_reply_to_id: 1 },
      ],
      [
        {
          id: 99,
          body: '<!-- gitlab-review:summary -->\n\n### Code Review\n\nAll good.\n\nReviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) v1.0.0 for commit 0123456789abcdef0123456789abcdef01234567.',
        },
      ],
    );

    // extractExistingFingerprints sees the bot comment's markers.
    const fps = extractExistingFingerprints(discussions);
    expect(fps.has(generated.fingerprints.primary)).toBe(true);

    // findExistingSummaryNote finds the issue-comment summary by its marker.
    expect(findExistingSummaryNote(discussions)?.id).toBe(99);
    expect(findExistingReviewedCommitSha(discussions)).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );

    // extractPriorThreads pairs the bot note with the human reply on a changed file.
    const threads = extractPriorThreads(discussions, new Set(['src/index.ts']));
    expect(threads).toHaveLength(1);
    expect(threads[0].replies).toEqual(['please fix']);
  });
});

/**
 * A resolved review thread's comment ids, shaped as the GraphQL `reviewThreads`
 * query returns them. `ids` land in the resolved set only when `isResolved`.
 */
interface ResolvedThreadStub {
  isResolved: boolean;
  ids: number[];
}

/** Routes GitHub API requests by method + path so one mock backs a whole run. */
function routedFetch(
  overrides: {
    reviewComments?: unknown[];
    issueComments?: unknown[];
    reviewThreads?: ResolvedThreadStub[];
  } = {},
): {
  fetchImpl: ReturnType<typeof vi.fn>;
  calls: { method: string; url: string; body?: string }[];
} {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body as string | undefined });
    if (method === 'POST' && url.endsWith('/graphql')) {
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: (overrides.reviewThreads ?? []).map((t) => ({
                    isResolved: t.isResolved,
                    comments: { nodes: t.ids.map((id) => ({ databaseId: id })) },
                  })),
                },
              },
            },
          },
        }),
      );
    }
    if (method === 'GET' && url.endsWith('/pulls/7')) {
      return new Response(
        JSON.stringify({
          head: { ref: 'feature', sha: 'head-sha' },
          base: { ref: 'main', sha: 'base-sha' },
          title: 'Add X',
          body: 'Body',
        }),
      );
    }
    if (method === 'GET' && url.includes('/pulls/7/comments')) {
      return new Response(JSON.stringify(overrides.reviewComments ?? []));
    }
    if (method === 'GET' && url.includes('/issues/7/comments')) {
      return new Response(JSON.stringify(overrides.issueComments ?? []));
    }
    if (method === 'POST' && url.includes('/pulls/7/reviews')) {
      return new Response(JSON.stringify({ id: 555 }));
    }
    if (method === 'POST' && url.includes('/issues/7/comments')) {
      return new Response(JSON.stringify({ id: 42, body: 'x' }));
    }
    if (method === 'PATCH' && url.includes('/issues/comments/')) {
      return new Response(JSON.stringify({ id: 99, body: 'x' }));
    }
    return new Response('not found', { status: 404 });
  });
  return { fetchImpl, calls };
}

function makePlatform(fetchImpl: ReturnType<typeof vi.fn>): GitHubPlatform {
  return new GitHubPlatform({ token: 'gh-token', owner: 'octo', repo: 'repo', pull: 7, fetchImpl });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitHubPlatform', () => {
  it('getMergeRequest maps head/base refs and title/body', async () => {
    const { fetchImpl } = routedFetch();
    const mr = await makePlatform(fetchImpl).getMergeRequest();
    expect(mr).toEqual({
      source_branch: 'feature',
      target_branch: 'main',
      title: 'Add X',
      description: 'Body',
    });
  });

  it('getRefs maps head_sha and reuses the memoized pull request', async () => {
    const { fetchImpl, calls } = routedFetch();
    const platform = makePlatform(fetchImpl);

    await platform.getMergeRequest();
    const refs = await platform.getRefs();

    expect(refs.head_sha).toBe('head-sha');
    // A single PR GET backs both getMergeRequest and getRefs.
    expect(calls.filter((c) => c.url.endsWith('/pulls/7'))).toHaveLength(1);
  });

  it('lastResponse captures the most recent HTTP response', async () => {
    const { fetchImpl } = routedFetch();
    const platform = makePlatform(fetchImpl);
    expect(platform.lastResponse()).toBeUndefined();
    await platform.getMergeRequest();
    const last = platform.lastResponse();
    expect(last?.method).toBe('GET');
    expect(last?.status).toBe(200);
    expect(last?.url).toContain('/pulls/7');
  });

  it('getDiscussions normalizes review + issue comments', async () => {
    const { fetchImpl } = routedFetch({
      reviewComments: [{ id: 1, body: 'inline', path: 'src/index.ts', line: 3, side: 'RIGHT' }],
      issueComments: [{ id: 10, body: 'note' }],
    });
    const discussions = await makePlatform(fetchImpl).getDiscussions();
    expect(discussions).toHaveLength(2);
    expect(discussions[0].notes[0].id).toBe(1);
    expect(discussions[1].notes[0].id).toBe(10);
  });

  it('getDiscussions flags resolved threads so carry-over drops them', async () => {
    // Two bot findings with fingerprint markers; only the first thread is resolved.
    const resolvedBody = '**issue: resolved bug**\n\n<!-- code-review:fingerprint-primary:aaaa -->';
    const openBody = '**issue: open bug**\n\n<!-- code-review:fingerprint-primary:bbbb -->';
    const { fetchImpl } = routedFetch({
      reviewComments: [
        { id: 1, body: resolvedBody, path: 'src/a.ts', line: 3, side: 'RIGHT' },
        { id: 2, body: openBody, path: 'src/b.ts', line: 4, side: 'RIGHT' },
      ],
      reviewThreads: [{ isResolved: true, ids: [1] }],
    });

    const discussions = await makePlatform(fetchImpl).getDiscussions();

    // extractOpenBotFindings keeps only the still-open finding, mirroring GitLab.
    const open = extractOpenBotFindings(discussions);
    expect(open).toHaveLength(1);
    expect(open[0].file).toBe('src/b.ts');
  });

  it('postComments posts one batched review with commit_id, skipping duplicates and off-diff', async () => {
    const { fetchImpl, calls } = routedFetch();
    const platform = makePlatform(fetchImpl);
    await platform.getRefs();

    const generated = platform.buildComments(
      [comment(), comment({ body: 'off diff', line: 999 })],
      DIFF,
      REFS,
      new Set(),
    );
    // Mark the placed finding as a duplicate to prove it is filtered out; the
    // remaining one has a null payload (off-diff) and must also be skipped.
    const placed = generated.find((g) => g.payload !== null);
    if (placed) placed.duplicate = true;

    const result = await platform.postComments(generated, 'direct');
    expect(result.posted).toBe(0);
    expect(calls.some((c) => c.url.includes('/reviews'))).toBe(false);
  });

  it('postComments batches fresh placed comments into one review call', async () => {
    const { fetchImpl, calls } = routedFetch();
    const platform = makePlatform(fetchImpl);
    await platform.getRefs();

    const generated = platform.buildComments([comment()], DIFF, REFS, new Set());
    const result = await platform.postComments(generated, 'direct');

    expect(result.posted).toBe(1);
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/reviews'));
    expect(post?.url).toBe('https://api.github.com/repos/octo/repo/pulls/7/reviews');
    const payload = JSON.parse(post?.body ?? '{}');
    expect(payload.commit_id).toBe('head-sha');
    expect(payload.event).toBe('COMMENT');
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({ path: 'src/index.ts', line: 3, side: 'RIGHT' });
  });

  it('retries comments individually when the batched review 422s, dropping the rejected', async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      const body = init.body as string | undefined;
      calls.push({ method, url, body });
      if (method === 'POST' && url.includes('/pulls/7/reviews')) {
        const payload = JSON.parse(body ?? '{}');
        // The batched review (>1 comment) 422s; on the per-comment retry, the
        // off-diff context comment (line 1) is still rejected but line 3 lands.
        if (payload.comments.length > 1) return new Response('unprocessable', { status: 422 });
        if (payload.comments[0].line === 1) return new Response('bad line', { status: 422 });
        return new Response(JSON.stringify({ id: 1 }));
      }
      return new Response('not found', { status: 404 });
    });
    const platform = makePlatform(fetchImpl);

    // buildComments captures the commit id, so no getRefs()/PR fetch is needed.
    const generated = platform.buildComments(
      [comment(), comment({ body: 'context finding', line: 1 })],
      DIFF,
      REFS,
      new Set(),
    );
    const result = await platform.postComments(generated, 'direct');

    expect(result.posted).toBe(1);
    const reviewPosts = calls.filter((c) => c.method === 'POST' && c.url.includes('/reviews'));
    // 1 batched attempt + 2 single-comment retries.
    expect(reviewPosts).toHaveLength(3);
  });

  it('rethrows the batch 422 when every individual retry also fails', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if ((init.method ?? 'GET') === 'POST' && url.includes('/reviews')) {
        return new Response('unprocessable', { status: 422 });
      }
      return new Response('not found', { status: 404 });
    });
    const platform = makePlatform(fetchImpl);
    const generated = platform.buildComments([comment()], DIFF, REFS, new Set());
    await expect(platform.postComments(generated, 'direct')).rejects.toThrow();
  });

  it('upsertSummary creates a new issue comment when none exists', async () => {
    const { fetchImpl, calls } = routedFetch();
    const result = await makePlatform(fetchImpl).upsertSummary('All good.', [], {});
    expect(result).toEqual({ action: 'created', noteId: 42 });
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/issues/7/comments'));
    expect(post?.url).toBe('https://api.github.com/repos/octo/repo/issues/7/comments');
  });

  it('upsertSummary updates the existing summary issue comment', async () => {
    const { fetchImpl, calls } = routedFetch();
    const discussions = normalizeGitHubDiscussions(
      [],
      [{ id: 99, body: '<!-- gitlab-review:summary -->\n\n### Code Review\n\nold' }],
    );
    const result = await makePlatform(fetchImpl).upsertSummary('new summary', discussions, {});
    expect(result).toEqual({ action: 'updated', noteId: 99 });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe('https://api.github.com/repos/octo/repo/issues/comments/99');
  });
});

describe('parseGitHubRepository', () => {
  it('splits a valid owner/repo slug', () => {
    expect(parseGitHubRepository('octocat/hello-world')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseGitHubRepository('  octo/repo  ')).toEqual({ owner: 'octo', repo: 'repo' });
  });

  it.each(['norepo', '/repo', 'owner/', 'a/b/c', '', '   '])(
    'rejects the malformed slug %j',
    (slug) => {
      expect(() => parseGitHubRepository(slug)).toThrow(ConfigError);
    },
  );
});

describe('parseGitHubPullNumber', () => {
  it('parses a positive integer string', () => {
    expect(parseGitHubPullNumber('42')).toBe(42);
  });

  it('trims surrounding whitespace', () => {
    expect(parseGitHubPullNumber(' 7 ')).toBe(7);
  });

  it.each(['0', '-1', '1.5', 'abc', '', ' '])('rejects %j', (value) => {
    expect(() => parseGitHubPullNumber(value)).toThrow(ConfigError);
  });
});
