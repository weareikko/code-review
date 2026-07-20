import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { run } from './cli.js';
import type { Config } from './config.js';
import { runReview } from './gitlab-review.js';
import { buildGitHubComments, type GitHubReviewCommentPayload } from './platforms/github.js';
import { buildReviewedCommitFooter, SUMMARY_MARKER } from './posting.js';
import type { DiffRefs } from './types.js';

// Deterministic diff + reviewer output shared with the mocked git/reviewer
// layers. The single added line (`const b = 2;`) is new-file line 2 on the RIGHT
// side, which the reviewer comment anchors to.
const fixtures = vi.hoisted(() => {
  const diff = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    'index 0000001..0000002 100644',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,2 +1,3 @@',
    ' const a = 1;',
    '+const b = 2;',
    ' const c = 3;',
    '',
  ].join('\n');
  const review = [
    '```json',
    JSON.stringify({
      summary: '**Overall:** one nit inline.',
      comments: [{ file: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'Prefer a clearer name.' }],
    }),
    '```',
    '',
  ].join('\n');
  // Mutable so an individual test can inject a different diff/review before a run
  // (off-diff findings, carryover fixtures); reset to the defaults in beforeEach.
  return { diff, review, defaultDiff: diff, defaultReview: review };
});

// The review core reads the diff and commit log from LOCAL git; stub those I/O
// calls so the integration test drives the platform seam without a real repo.
vi.mock('./git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git.js')>();
  return {
    ...actual,
    prepareGitHistory: vi.fn(async () => {}),
    getMergeDiff: vi.fn(async () => fixtures.diff),
    getMergeCommitLog: vi.fn(async () => 'deadbeef Add b'),
  };
});

// Replace the LLM-backed reviewer with a deterministic stub that writes the same
// output file the real reviewer would, so parsing → dedup → posting run unchanged.
vi.mock('./gitlab-review.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitlab-review.js')>();
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');
  return {
    ...actual,
    runReview: vi.fn(async (config: Config, options: { cwd: string }) => {
      await fs.writeFile(nodePath.resolve(options.cwd, config.reviewFile), fixtures.review, 'utf8');
      return {
        model: config.model,
        thinkingLevel: config.thinkingLevel,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        skills: [],
        sizeNotice: { sizeSkippedFiles: [] },
      };
    }),
  };
});

// The module-mocked reviewer, typed as a mock so tests can inspect its calls
// (avoids `vi.mocked(...)` in the test body, which the lint config forbids).
const runReviewMock = runReview as unknown as Mock;

// A 40-hex commit SHA so the reviewed-commit footer regex (which requires 40 hex
// chars) matches on the re-run and triggers the skip.
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

// Refs matching the in-memory backend's head SHA, used to pre-build a realistic
// prior bot comment body (footer + fingerprint markers) for the carryover test.
const REFS: DiffRefs = { base_sha: 'basesha', start_sha: 'basesha', head_sha: HEAD_SHA };

interface GitHubComment {
  id: number;
  body: string;
}
interface GitHubReviewComment {
  id: number;
  path: string;
  line: number;
  side: string;
  body: string;
}

/**
 * A stateful in-memory GitHub REST backend: posted inline review comments and the
 * upserted summary issue comment persist so a second run sees them (dedup) and a
 * third run finds the reviewed-commit footer (skip).
 */
function makeGitHubBackend() {
  const reviewComments: GitHubReviewComment[] = [];
  const issueComments: GitHubComment[] = [];
  const reviewsPosted: Array<{ commit_id: string; comments?: GitHubReviewComment[] }> = [];
  // Ids of review comments whose thread is resolved. REST omits resolution, so
  // tests seed this to model GitHub's GraphQL `reviewThreads.isResolved`.
  const resolvedCommentIds = new Set<number>();
  let nextId = 1000;
  const jsonResponse = (value: unknown): Response =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    const bodyJson = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

    // Thread resolution lives only in GraphQL; each inline comment is its own
    // single-comment thread, resolved when its id is in `resolvedCommentIds`.
    if (method === 'POST' && path.endsWith('/graphql')) {
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: reviewComments.map((c) => ({
                  isResolved: resolvedCommentIds.has(c.id),
                  comments: { nodes: [{ databaseId: c.id }] },
                })),
              },
            },
          },
        },
      });
    }

    if (method === 'GET' && path.endsWith('/pulls/1')) {
      return jsonResponse({
        head: { ref: 'feature', sha: HEAD_SHA },
        base: { ref: 'main', sha: 'basesha' },
        title: 'Add b',
        body: 'Adds b',
      });
    }
    if (method === 'GET' && path.endsWith('/pulls/1/comments')) return jsonResponse(reviewComments);
    if (method === 'GET' && path.endsWith('/issues/1/comments')) return jsonResponse(issueComments);
    if (method === 'POST' && path.endsWith('/pulls/1/reviews')) {
      reviewsPosted.push(bodyJson);
      for (const c of bodyJson.comments ?? []) {
        reviewComments.push({
          id: nextId++,
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        });
      }
      return jsonResponse({ id: nextId++ });
    }
    if (method === 'POST' && path.endsWith('/issues/1/comments')) {
      const comment = { id: nextId++, body: bodyJson.body };
      issueComments.push(comment);
      return jsonResponse(comment);
    }
    if (method === 'PATCH' && path.includes('/issues/comments/')) {
      const id = Number(path.slice(path.lastIndexOf('/') + 1));
      const found = issueComments.find((c) => c.id === id);
      if (found) found.body = bodyJson.body;
      return jsonResponse(found);
    }
    return new Response('not found', { status: 404 });
  });

  return { fetchImpl, reviewComments, issueComments, reviewsPosted, resolvedCommentIds };
}

function makeConfig(cwd: string, overrides: Partial<Config> = {}): Config {
  return {
    platform: 'github',
    project: '',
    mr: '',
    gitlabUrl: '',
    gitlabToken: '',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    githubRepository: 'octo/repo',
    githubPr: '1',
    githubToken: 'gh-token',
    githubApiUrl: 'https://api.github.com',
    githubServerUrl: 'https://github.com',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    reviewDepth: 'single',
    apiKey: 'k',
    reviewFile: 'code-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    postSummary: true,
    forceReview: false,
    verbose: false,
    cwd,
    ...overrides,
  } as Config;
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'gh-review-'));
  fixtures.diff = fixtures.defaultDiff;
  fixtures.review = fixtures.defaultReview;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
});

describe('run() over an in-memory GitHubPlatform', () => {
  it('generates, posts a batched review + summary, dedups, then skips a reviewed commit', async () => {
    const backend = makeGitHubBackend();
    vi.stubGlobal('fetch', backend.fetchImpl);

    // Run 1 (forced so the skip does not short-circuit): one inline finding posts
    // as a single batched review, and the summary is created.
    const first = await run(makeConfig(cwd, { forceReview: true }));
    expect(first.posted).toBe(1);
    expect(first.summary?.action).toBe('created');
    expect(backend.reviewsPosted).toHaveLength(1);
    expect(backend.reviewsPosted[0].commit_id).toBe(HEAD_SHA);
    expect(backend.reviewsPosted[0].comments).toEqual([
      expect.objectContaining({ path: 'src/foo.ts', line: 2, side: 'RIGHT' }),
    ]);
    expect(backend.issueComments).toHaveLength(1);

    // The artifact is written even though posting happened.
    const artifact = JSON.parse(await readFile(join(cwd, 'review-comments.json'), 'utf8'));
    expect(artifact).toHaveLength(1);

    // Run 2 (still forced): the finding's fingerprint already exists on the posted
    // review comment, so nothing new posts and the summary is updated in place.
    const second = await run(makeConfig(cwd, { forceReview: true }));
    expect(second.posted).toBe(0);
    expect(second.summary?.action).toBe('updated');
    expect(backend.reviewsPosted).toHaveLength(1);
    expect(backend.issueComments).toHaveLength(1);

    // Run 3 (not forced): the summary's reviewed-commit footer matches the head
    // SHA, so the whole run is skipped before any review work.
    const third = await run(makeConfig(cwd));
    expect(third.skipped).toBe(true);
    expect(third.posted).toBe(0);
    expect(backend.reviewsPosted).toHaveLength(1);
  });
});

describe('run() with commits input mode', () => {
  it('passes the prior reviewed commit as sinceRef for an incremental pass', async () => {
    const backend = makeGitHubBackend();
    vi.stubGlobal('fetch', backend.fetchImpl);

    // A prior summary note whose reviewed-commit footer points at an older commit
    // (≠ head), so the incremental commits-mode pass scopes the review to it.
    const OLD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
    backend.issueComments.push({
      id: 500,
      body: `${SUMMARY_MARKER}\n\n### Code Review\n\n<sub>${buildReviewedCommitFooter(OLD_SHA)}</sub>`,
    });

    await run(makeConfig(cwd, { inputMode: 'commits' }));

    const lastCall = runReviewMock.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({ sinceRef: OLD_SHA });
  });

  it('leaves sinceRef undefined when there is no prior review (full range)', async () => {
    const backend = makeGitHubBackend();
    vi.stubGlobal('fetch', backend.fetchImpl);

    await run(makeConfig(cwd, { inputMode: 'commits' }));

    const lastCall = runReviewMock.mock.calls.at(-1);
    expect(lastCall?.[1].sinceRef).toBeUndefined();
  });
});

describe('run() over GitHub in dry-run mode', () => {
  it('writes the artifacts but never posts to GitHub', async () => {
    const backend = makeGitHubBackend();
    vi.stubGlobal('fetch', backend.fetchImpl);

    const result = await run(makeConfig(cwd, { dryRun: true }));

    // Posting is disabled: no batched review, no summary issue comment, and the
    // returned summary is null even though the reviewer emitted one.
    expect(result.posted).toBe(0);
    expect(result.summary).toBeNull();
    expect(backend.reviewsPosted).toHaveLength(0);
    expect(backend.issueComments).toHaveLength(0);

    // The comment + usage artifacts are still written (dry-run contract).
    const artifact = JSON.parse(await readFile(join(cwd, 'review-comments.json'), 'utf8'));
    expect(artifact).toHaveLength(1);
    const usage = JSON.parse(await readFile(join(cwd, 'review-usage.json'), 'utf8'));
    expect(usage.model).toBe('anthropic/claude-sonnet-4-5');
  });
});

describe('run() over GitHub with an off-diff finding', () => {
  it('drops the un-anchorable comment from the batched review (guards 422)', async () => {
    // One on-diff finding (new-file line 2) and one on a line outside the diff.
    // resolveDiffLine returns null for the latter, so the poster drops it rather
    // than let GitHub 422 the whole review.
    fixtures.review = [
      '```json',
      JSON.stringify({
        summary: '**Overall:** two findings.',
        comments: [
          { file: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'On the diff.' },
          { file: 'src/foo.ts', line: 999, side: 'RIGHT', body: 'Off the diff.' },
        ],
      }),
      '```',
      '',
    ].join('\n');

    const backend = makeGitHubBackend();
    vi.stubGlobal('fetch', backend.fetchImpl);

    const result = await run(makeConfig(cwd, { forceReview: true }));

    // Only the anchorable finding posts; the batched review carries one comment.
    expect(result.posted).toBe(1);
    expect(backend.reviewsPosted).toHaveLength(1);
    expect(backend.reviewsPosted[0].comments).toHaveLength(1);
    expect(backend.reviewsPosted[0].comments?.[0]).toEqual(
      expect.objectContaining({ path: 'src/foo.ts', line: 2, side: 'RIGHT' }),
    );

    // Both findings are still recorded in the artifact; the off-diff one has a
    // null payload so a reader can see it was generated but not placed.
    const artifact = JSON.parse(await readFile(join(cwd, 'review-comments.json'), 'utf8'));
    expect(artifact).toHaveLength(2);
    expect(artifact.filter((entry: { payload: unknown }) => entry.payload === null)).toHaveLength(
      1,
    );
  });
});

describe('run() over GitHub with an unresolved prior finding', () => {
  it('carries the still-open finding into the summary note', async () => {
    const backend = makeGitHubBackend();

    // Seed an unresolved bot inline finding from an earlier run on a changed file.
    // Its body carries real footer + fingerprint markers, and this run does NOT
    // re-emit it (the current finding is on a different line), so it must be
    // carried into the summary's "Still open" block (#92).
    const [prior] = buildGitHubComments(
      [
        {
          file: 'src/foo.ts',
          line: 3,
          side: 'RIGHT',
          severity: 'warn',
          confidence: 'high',
          body: 'issue: an earlier unresolved concern',
        },
      ],
      fixtures.defaultDiff,
      REFS,
      new Set(),
    );
    const priorBody = (prior.payload as GitHubReviewCommentPayload).body;
    backend.reviewComments.push({
      id: 500,
      path: 'src/foo.ts',
      line: 3,
      side: 'RIGHT',
      body: priorBody,
    });

    vi.stubGlobal('fetch', backend.fetchImpl);

    const result = await run(makeConfig(cwd, { forceReview: true }));

    // The current finding still posts, and a fresh summary is created.
    expect(result.posted).toBe(1);
    expect(result.summary?.action).toBe('created');

    // The upserted summary lists the carried-over finding with its location.
    expect(backend.issueComments).toHaveLength(1);
    expect(backend.issueComments[0].body).toContain('Still open from earlier reviews');
    expect(backend.issueComments[0].body).toContain('src/foo.ts:3');
  });

  it('does not carry a resolved prior finding into the summary note', async () => {
    const backend = makeGitHubBackend();

    // Same seed as above, but the thread is resolved on GitHub. Resolution lives
    // only in GraphQL, so REST alone can't see it — the fix reads `isResolved`
    // and must therefore drop this finding from the "Still open" block.
    const [prior] = buildGitHubComments(
      [
        {
          file: 'src/foo.ts',
          line: 3,
          side: 'RIGHT',
          severity: 'warn',
          confidence: 'high',
          body: 'issue: an earlier concern that was addressed',
        },
      ],
      fixtures.defaultDiff,
      REFS,
      new Set(),
    );
    const priorBody = (prior.payload as GitHubReviewCommentPayload).body;
    backend.reviewComments.push({
      id: 500,
      path: 'src/foo.ts',
      line: 3,
      side: 'RIGHT',
      body: priorBody,
    });
    backend.resolvedCommentIds.add(500);

    vi.stubGlobal('fetch', backend.fetchImpl);

    const result = await run(makeConfig(cwd, { forceReview: true }));

    expect(result.summary?.action).toBe('created');
    expect(backend.issueComments).toHaveLength(1);
    // The resolved finding is gone — no stale "Still open" reference to it.
    expect(backend.issueComments[0].body).not.toContain('Still open from earlier reviews');
    expect(backend.issueComments[0].body).not.toContain('addressed');
  });
});
