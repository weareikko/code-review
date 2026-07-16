import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { resolveProviderApiKey } from '../../src/config.js';
import { runReview } from '../../src/gitlab-review.js';
import { parseReviewMarkdownWithWarnings } from '../../src/parser.js';
import type { ReviewComment } from '../../src/types.js';
import { createTrajectoryCollector, filesRead } from './trajectory.js';

/**
 * Real-PR input-mode probe: run the modes against an actual many-file PR diff
 * (studiometa/ui#511, 33 files, ~102k chars). No planted ground truth, so recall
 * is RELATIVE — the full-budget inline arm (which sees the whole diff) is the
 * reference, and every other arm is scored by how much of that reference it
 * recovers, plus any novel findings and its cost. This tests the crux the
 * synthetic pilot could not: does full-access disk beat a budget-constrained
 * inline arm forced to drop most files, or does inline+retrieval already close
 * the gap?
 *
 *   INPUT_MODE_REALPR_RUN=1 npm run test:evals -- input-mode-realpr
 */

const RUN = process.env.INPUT_MODE_REALPR_RUN === '1';
const TRIALS = Number(process.env.INPUT_MODE_TRIALS ?? 2);
const EVAL_MODEL = process.env.CODE_REVIEW_EVAL_MODEL ?? 'cloudflare-ai-gateway/gpt-5.4';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'studiometa-ui-511.diff');

interface Arm {
  label: string;
  inputMode: 'inline' | 'disk';
  maxDiffChars: number;
}

const ARMS: Arm[] = [
  { label: 'inline-full', inputMode: 'inline', maxDiffChars: 150_000 },
  { label: 'inline-constrained', inputMode: 'inline', maxDiffChars: 35_000 },
  { label: 'disk', inputMode: 'disk', maxDiffChars: 35_000 },
];

function makeConfig(over: Partial<Config>): Config {
  const model = EVAL_MODEL;
  return {
    project: 'test',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'test',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model,
    modelPool: [],
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    reviewDepth: 'single',
    apiKey: resolveProviderApiKey(model),
    baseUrl: process.env.CODE_REVIEW_BASE_URL ?? '',
    maxTokens: Number(process.env.CODE_REVIEW_MAX_TOKENS ?? 0),
    maxDiffChars: 100_000,
    decomposeHintLines: 0,
    reviewFile: 'code-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: true,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: process.cwd(),
    skills: [],
    refreshGitSkills: false,
    ...over,
  };
}

const isSevere = (c: ReviewComment): boolean => c.severity === 'critical' || c.severity === 'warn';
const matches = (a: ReviewComment, b: ReviewComment): boolean =>
  a.file === b.file && Math.abs(a.line - b.line) <= 3;

/** Dedup a finding list by file + line (±3). */
function dedup(findings: ReviewComment[]): ReviewComment[] {
  const out: ReviewComment[] = [];
  for (const f of findings) if (!out.some((o) => matches(o, f))) out.push(f);
  return out;
}

interface ArmRun {
  severe: ReviewComment[];
  tokens: number;
  cost: number;
  turns: number;
  filesRead: number;
}

async function runArm(diff: string, arm: Arm): Promise<ArmRun> {
  const cwd = await mkdtemp(join(tmpdir(), 'realpr-'));
  try {
    const config = makeConfig({ cwd, inputMode: arm.inputMode, maxDiffChars: arm.maxDiffChars });
    const { trajectory, attach } = createTrajectoryCollector();
    const usage = await runReview(config, { diff, attachTelemetry: (a) => attach(a) });
    const parsed = parseReviewMarkdownWithWarnings(
      await readFile(join(cwd, config.reviewFile), 'utf8'),
    );
    return {
      severe: parsed.comments.filter(isSevere),
      tokens: usage.tokens.total,
      cost: usage.cost.total,
      turns: trajectory.turns,
      filesRead: new Set(filesRead(trajectory).map((p) => basename(p))).size,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

describe.skipIf(!RUN)('input-mode comparison on a real PR (studiometa/ui#511)', () => {
  it(
    'compares relative recall / cost / read behaviour across modes',
    async () => {
      const diff = await readFile(FIXTURE, 'utf8');
      const runs = new Map<string, ArmRun[]>();
      for (const arm of ARMS) {
        const list: ArmRun[] = [];
        for (let t = 0; t < TRIALS; t += 1) {
          try {
            list.push(await runArm(diff, arm));
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`  ${arm.label} trial ${t} failed: ${(error as Error).message}`);
          }
        }
        runs.set(arm.label, list);
      }

      // Reference = union of the full-inline arm's severe findings.
      const reference = dedup((runs.get('inline-full') ?? []).flatMap((r) => r.severe));

      const rows = ARMS.map((arm) => {
        const list = runs.get(arm.label) ?? [];
        const found = dedup(list.flatMap((r) => r.severe));
        const recovered = reference.filter((ref) => found.some((f) => matches(f, ref))).length;
        const novel = found.filter((f) => !reference.some((ref) => matches(ref, f))).length;
        return {
          arm: arm.label,
          severeFindings: found.length,
          recoveredOfRef: reference.length
            ? `${Math.round((recovered / reference.length) * 100)}%`
            : 'n/a',
          novel,
          tokens: Math.round(mean(list.map((r) => r.tokens))),
          cost: Number(mean(list.map((r) => r.cost)).toFixed(4)),
          turns: Number(mean(list.map((r) => r.turns)).toFixed(1)),
          filesRead: Number(mean(list.map((r) => r.filesRead)).toFixed(1)),
        };
      });

      // eslint-disable-next-line no-console
      console.log(
        `\n=== studiometa/ui#511 — input-mode comparison (model=${EVAL_MODEL}, trials=${TRIALS}, reference=inline-full with ${reference.length} severe findings) ===`,
      );
      // eslint-disable-next-line no-console
      console.table(rows);
      expect(rows.length).toBe(ARMS.length);
    },
    45 * 60 * 1000,
  );
});
