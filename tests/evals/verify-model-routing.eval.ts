import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { Config } from '../../src/config.js';
import { resolveProviderApiKey } from '../../src/config.js';
import { runReview } from '../../src/gitlab-review.js';
import { parseReviewMarkdownWithWarnings } from '../../src/parser.js';

// Measurement harness / regression guard for stage-scoped model routing
// (`--verify-model`). Runs the same known-answer fixtures at `verify` depth for
// a few find/verify model pairings and reports recall, false-positive rate, and
// real cache-aware cost. Establishes and re-checks the finding that a cheap,
// high-recall finder paired with a strong, high-precision verifier matches an
// all-strong pipeline at a fraction of the cost.
//
// Calls real LLMs and costs money — OFF unless VERIFY_ROUTING_RUN=1. gpt-5.4 runs
// via the Cloudflare AI Gateway (CLOUDFLARE_* secrets); nano via direct OpenAI.
//
//   VERIFY_ROUTING_RUN=1 npm run test:evals -- verify-model-routing

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TRIALS = Number(process.env.VERIFY_ROUTING_TRIALS) || 2;

const NANO = 'openai/gpt-5.4-nano';
const GPT = 'cloudflare-ai-gateway/gpt-5.4';

const CONFIGS: Array<{ label: string; findModel: string; verifyModel: string }> = [
  { label: 'all-gpt-5.4', findModel: GPT, verifyModel: '' },
  { label: 'all-nano', findModel: NANO, verifyModel: '' },
  { label: 'nano-find/gpt-verify', findModel: NANO, verifyModel: GPT },
];

const FIXTURE_SET: Array<{ file: string; kind: 'recall' | 'precision' }> = [
  { file: 'async-foreach-bug.diff', kind: 'recall' },
  { file: 'php-promo-race.diff', kind: 'recall' },
  { file: 'react-stale-deps.diff', kind: 'recall' },
  { file: 'clean-ts.diff', kind: 'precision' },
  { file: 'justified-intentional.diff', kind: 'precision' },
];

const skip =
  process.env.VERIFY_ROUTING_RUN !== '1' ||
  !(process.env.CLOUDFLARE_API_KEY && process.env.OPENAI_API_KEY);

function makeConfig(findModel: string, verifyModel: string, cwd: string): Config {
  return {
    project: 'test',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'test',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: findModel,
    modelPool: [],
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    reviewDepth: 'verify',
    verifyModel,
    apiKey: resolveProviderApiKey(findModel),
    baseUrl: '',
    maxTokens: 0,
    maxDiffChars: 100_000,
    decomposeHintLines: 0,
    reviewFile: 'code-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: true,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd,
    skills: ['code-review'],
    refreshGitSkills: false,
  };
}

test.skipIf(skip)(
  'verify-model routing — recall/precision/cost across find/verify pairings',
  { timeout: 120_000 * CONFIGS.length * FIXTURE_SET.length * TRIALS },
  async () => {
    const rows: Array<{ config: string; kind: string; severe: number; cost: number }> = [];
    for (const cfg of CONFIGS) {
      for (const fx of FIXTURE_SET) {
        for (let t = 0; t < TRIALS; t += 1) {
          const dir = await mkdtemp(join(tmpdir(), 'vroute-'));
          try {
            const diff = await readFile(join(FIXTURES, fx.file), 'utf8');
            const usage = await runReview(makeConfig(cfg.findModel, cfg.verifyModel, dir), {
              diff,
            });
            const raw = await readFile(join(dir, 'code-review.md'), 'utf8');
            const severe = parseReviewMarkdownWithWarnings(raw).comments.filter(
              (c) => c.severity === 'critical' || c.severity === 'warn',
            ).length;
            rows.push({ config: cfg.label, kind: fx.kind, severe, cost: usage.cost.total });
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      }
    }

    const summary = CONFIGS.map((cfg) => {
      const rs = rows.filter((r) => r.config === cfg.label);
      const rec = rs.filter((r) => r.kind === 'recall');
      const prec = rs.filter((r) => r.kind === 'precision');
      return {
        config: cfg.label,
        recallRate: rec.length
          ? +(rec.filter((r) => r.severe > 0).length / rec.length).toFixed(2)
          : null,
        falsePositiveRate: prec.length
          ? +(prec.filter((r) => r.severe > 0).length / prec.length).toFixed(2)
          : null,
        avgCost: rs.length ? +(rs.reduce((a, r) => a + r.cost, 0) / rs.length).toFixed(5) : 0,
      };
    });
    // eslint-disable-next-line no-console
    console.log(
      `\n=== VERIFY-MODEL ROUTING (trials=${TRIALS}) ===\n${JSON.stringify(summary, null, 2)}`,
    );
    expect(rows.length).toBeGreaterThan(0);
  },
);
