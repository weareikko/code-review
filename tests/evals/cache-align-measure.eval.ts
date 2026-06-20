import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { Config } from '../../src/config.js';
import { runReview } from '../../src/gitlab-review.js';

// Standalone measurement harness for the Verify cache-alignment optimisation
// (diff + commit log moved into the shared, cacheable Verify system prompt).
// Runs the SAME multi-bug fixture at `verify` depth N times and records the
// real, cache-aware token/cost breakdown returned by runReview(). Not a
// pass/fail eval — it appends one JSON line per trial to RESULTS_FILE so a
// before/after diff of the file reveals the cost delta.
//
// Calls real LLMs and costs money, so it is OFF by default even when an API key
// is present (unlike the accuracy evals). Opt in explicitly with CACHE_ALIGN_RUN=1.
//
// Driven entirely by env so the same file measures baseline and after:
//   CACHE_ALIGN_RUN=1                   required — otherwise the harness skips
//   GITLAB_REVIEW_EVAL_MODEL            reviewer model (default haiku)
//   GITLAB_REVIEW_VERIFY_CONCURRENCY    1 = serial (best case), 4 = production default
//   CACHE_ALIGN_FIXTURE                 fixture diff (default multi-bug.diff)
//   CACHE_ALIGN_TRIALS                  trials (default 3)
//   CACHE_ALIGN_LABEL                   tag written into each record
//   CACHE_ALIGN_RESULTS                 output JSONL path
//
// Example (production-concurrency before/after on the large fixture):
//   CACHE_ALIGN_RUN=1 CACHE_ALIGN_FIXTURE=multi-bug-large.diff \
//     CACHE_ALIGN_LABEL=after npm run test:evals -- cache-align-measure

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TRIALS = Number(process.env.CACHE_ALIGN_TRIALS) || 3;
const LABEL = process.env.CACHE_ALIGN_LABEL ?? 'unlabeled';
const RESULTS_FILE = process.env.CACHE_ALIGN_RESULTS ?? join(tmpdir(), 'cache-align-results.jsonl');

const apiKey =
  process.env.GITLAB_REVIEW_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.CLAUDE_API_KEY ||
  '';

// Skip unless explicitly opted in AND a key is available. The CACHE_ALIGN_RUN
// gate keeps this paid measurement off the default `npm run test:evals` path.
const skip = process.env.CACHE_ALIGN_RUN !== '1' || !apiKey;

function makeConfig(cwd: string): Config {
  return {
    project: 'test',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'test',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: process.env.GITLAB_REVIEW_EVAL_MODEL ?? 'anthropic/claude-haiku-4-5-20251001',
    modelPool: [],
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    reviewDepth: 'verify',
    apiKey,
    baseUrl: process.env.GITLAB_REVIEW_BASE_URL ?? '',
    maxTokens: 0,
    maxDiffChars: 100_000,
    decomposeHintLines: 0,
    reviewFile: 'gitlab-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: true,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd,
    skills: [],
    refreshGitSkills: false,
  };
}

test.skipIf(skip)(
  `cache-align measurement [${LABEL}] — verify depth, ${TRIALS} trial(s)`,
  { timeout: 120_000 * TRIALS },
  async () => {
    const fixture = process.env.CACHE_ALIGN_FIXTURE ?? 'multi-bug.diff';
    const template = await readFile(join(FIXTURES, fixture), 'utf8');

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const dir = await mkdtemp(join(tmpdir(), 'cache-align-'));
      // Unique-per-trial nonce, identical across the find+verify calls WITHIN a
      // trial. Defeats cross-trial cache reuse (Anthropic's 5-min TTL would
      // otherwise let trial N read trial N-1's cache) while preserving the
      // within-run prefix caching this experiment measures.
      const nonce = `${LABEL}-${trial}-${Date.now()}`;
      const diff = template.replace('__NONCE__', nonce);
      try {
        const usage = await runReview(makeConfig(dir), { diff });
        const record = {
          label: LABEL,
          trial,
          model: usage.model,
          concurrency: process.env.GITLAB_REVIEW_VERIFY_CONCURRENCY ?? '4',
          tokens: usage.tokens,
          cost: usage.cost,
        };
        await appendFile(RESULTS_FILE, `${JSON.stringify(record)}\n`);
        // eslint-disable-next-line no-console
        console.log(
          `[${LABEL}] trial ${trial}: cost $${usage.cost.total.toFixed(6)} ` +
            `(in ${usage.tokens.input}, out ${usage.tokens.output}, ` +
            `cacheRead ${usage.tokens.cacheRead}, cacheWrite ${usage.tokens.cacheWrite})`,
        );
        expect(usage.tokens.total).toBeGreaterThan(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
);
