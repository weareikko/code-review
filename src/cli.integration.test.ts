import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './cli.js';
import type { Config } from './config.js';

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
  return { diff, review };
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

// A 40-hex commit SHA so the reviewed-commit footer regex (which requires 40 hex
// chars) matches on the re-run and triggers the skip.
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

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
  let nextId = 1000;
  const jsonResponse = (value: unknown): Response =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    const bodyJson = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

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

  return { fetchImpl, reviewComments, issueComments, reviewsPosted };
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
    reviewFile: 'gitlab-review.md',
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
