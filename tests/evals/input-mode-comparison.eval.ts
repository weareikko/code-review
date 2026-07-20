import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ARMS, EVAL_MODEL, runArm, type ArmResult } from './input-mode-comparison.js';
import { materializeRepo, type MaterializedRepo } from './materialize.js';
import { meanScores } from './scoring.js';
import { generateSyntheticReview, type BugKind, type SyntheticSpec } from './synthetic.js';

/**
 * Paid comparison of input modes (inline vs disk vs commit-exploration) on large
 * multi-file synthetic changes with planted bugs. Gated behind INPUT_MODE_RUN so
 * it never runs in the normal suite. Prints a recall/precision/cost/coverage
 * table. Pilot defaults: 2 fixtures x 4 arms x 2 trials at single depth.
 *
 *   INPUT_MODE_RUN=1 npm run test:evals -- input-mode-comparison
 *
 * Knobs: INPUT_MODE_TRIALS, CODE_REVIEW_EVAL_MODEL.
 */

const RUN = process.env.INPUT_MODE_RUN === '1';
const TRIALS = Number(process.env.INPUT_MODE_TRIALS ?? 2);

// Large fixtures (~269k chars, 2.7x the 100k budget) with planted bugs in small
// files that rank last and get dropped first — forcing inline to rely on
// retrieval to catch them. This is the crossover regime the sub-budget pilot and
// the too-clean real PRs could not test.
const FIXTURES: { name: string; spec: SyntheticSpec }[] = [
  {
    name: 'auth-large',
    spec: {
      fillerFiles: 18,
      fillerLinesPerFile: 500,
      bugs: [
        'sql-injection',
        'missing-authz',
        'unhandled-null',
        'off-by-one',
        'hardcoded-secret',
        'shared-mutable-race',
      ] as BugKind[],
      commits: 5,
    },
  },
  {
    name: 'pipeline-large',
    spec: {
      fillerFiles: 20,
      fillerLinesPerFile: 450,
      bugs: [
        'missing-await-loop',
        'off-by-one',
        'shared-mutable-race',
        'sql-injection',
        'missing-authz',
      ] as BugKind[],
      commits: 6,
    },
  },
];

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number | null): string => (x === null ? ' n/a' : `${Math.round(x * 100)}%`);

describe.skipIf(!RUN)('input-mode comparison (paid)', () => {
  it(
    'runs the matrix and reports recall/precision/cost/coverage',
    async () => {
      const repos: MaterializedRepo[] = [];
      const rows: {
        fixture: string;
        arm: string;
        recall: string;
        recallSevere: string;
        precision: string;
        coverage: string;
        tokens: number;
        cost: number;
        gitCalls: number;
        turns: number;
      }[] = [];

      for (const fixture of FIXTURES) {
        const review = generateSyntheticReview(fixture.spec);
        const repo = await materializeRepo(review);
        repos.push(repo);
        // eslint-disable-next-line no-console
        console.log(
          `\n[fixture ${fixture.name}] ${review.files.length} files, ${Math.round(review.totalChars / 1000)}k chars, ${review.groundTruth.length} planted bugs`,
        );

        for (const arm of ARMS) {
          const results: ArmResult[] = [];
          for (let t = 0; t < TRIALS; t += 1) {
            try {
              results.push(await runArm({ review, arm, repo, model: EVAL_MODEL }));
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error(
                `  ${fixture.name}/${arm.label} trial ${t} failed: ${(error as Error).message}`,
              );
            }
          }
          if (results.length === 0) continue;
          const agg = meanScores(results.map((r) => r.score));
          rows.push({
            fixture: fixture.name,
            arm: arm.label,
            recall: pct(agg.recall),
            recallSevere: pct(agg.recallSevere),
            precision: pct(agg.precision),
            coverage: pct(agg.bugFileCoverage),
            tokens: Math.round(mean(results.map((r) => r.tokens))),
            cost: Number(mean(results.map((r) => r.cost)).toFixed(4)),
            gitCalls: Number(mean(results.map((r) => r.gitToolCalls)).toFixed(1)),
            turns: Number(mean(results.map((r) => r.turns)).toFixed(1)),
          });
        }
      }

      // eslint-disable-next-line no-console
      console.log(`\n=== input-mode comparison (model=${EVAL_MODEL}, trials=${TRIALS}) ===`);
      // eslint-disable-next-line no-console
      console.table(rows);

      for (const repo of repos) await rm(repo.dir, { recursive: true, force: true });
      expect(rows.length).toBeGreaterThan(0);
    },
    45 * 60 * 1000,
  );
});
