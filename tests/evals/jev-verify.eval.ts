/**
 * Can TypeSafe's Jev replace (or pre-filter) the Verify stage?
 *
 * The Verify stage's output is a typed decision — keep | downgrade | drop — which
 * is exactly the shape Jev returns natively, at ~1/100th the cost of running an
 * adversarial agent per finding. This measures whether the decision survives the
 * swap on REAL findings, rather than on hand-labelled fixtures.
 *
 * Four phases, each cached in test-results/jev-verify.json so a rerun is cheap:
 *   1. FIND     — one Find pass per PR (depth `single`), frozen. Both verifier
 *                 arms then score the SAME findings; re-running Find per arm
 *                 would make the comparison meaningless, since Find is noisy.
 *   2. TRUTH    — `judgeFindingCorrectness` asks, per finding, whether its
 *                 specific claim is TRUE of the change, with read-only access to
 *                 the checkout and N independent samples. Only unanimous samples
 *                 become ground truth; splits and UNPROVABLE are excluded.
 *   3. JEV      — one decisions call per severe finding.
 *   4. AGENTIC  — the production verifier (same prompts, same read-only repo
 *                 tools) over those same findings, as the baseline.
 *
 * A finding should be KEPT when its claim is true AND this diff introduced the
 * behaviour; it should be DROPPED when the claim is false, or true but about
 * behaviour that predates the change — the Verify stage guards what the change
 * introduces, so refuting a pre-existing-behaviour finding is correct.
 *
 * `matchAndVerdict` still runs, but its CONFIRMED/PLAUSIBLE/FABRICATED verdict is
 * now a DIAGNOSTIC only, reported as a confusion table against the judge. It
 * labels a finding by whether it lines up with a human gold comment, which is the
 * right question for recall and the wrong one for scoring a verifier: the first
 * run of this eval had all four "FABRICATED" findings turn out technically
 * correct, and several "CONFIRMED" ones blaming the diff for behaviour it did not
 * change — which the agentic verifier correctly refuted and was scored wrong for.
 *
 * Prereq: materialize first — `node tests/evals/fixtures/swe-prbench/materialize.mjs`.
 * Needs OPENROUTER_API_KEY (Jev + reviewer) and a judge key.
 * Writes test-results/jev-verify.{json,md}.
 *
 * Env: GITLAB_REVIEW_JEV_MODEL / _JEVV_MODEL / _JEVV_JUDGE_MODEL /
 *      _JEVV_TRUTH_SAMPLES / _JEVV_TRIALS / _JEVV_LIMIT / _JEVV_ONLY /
 *      _JEVV_CONCURRENCY / _JEVV_FRESH / _JEVV_SKIP_AGENTIC.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Confidence, Severity, Side } from '../../src/types.js';
import {
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  parseVerdict,
  type VerifyDecision,
} from '../../src/verify.js';
import { runAgentForText } from './agent-runner.js';
import { judgeFindingCorrectness, type CorrectnessLabel } from './finding-correctness.js';
import {
  askJev,
  buildJevVerifyState,
  jevAvailable,
  parseJevVerdict,
  JEV_MODEL,
  VERIFY_QUESTIONS,
} from './jev.js';
import { judgeAvailable } from './review-suite.js';
import {
  isMaterialized,
  loadInstances,
  matchAndVerdict,
  repoDirFor,
  runReviewer,
  RESULTS_DIR,
  type Instance,
  type OurFinding,
} from './swe-prbench-lib.js';

const FIND_MODEL = process.env.GITLAB_REVIEW_JEVV_MODEL ?? 'openrouter/openai/gpt-5.6-luna';
const CONCURRENCY = Number(process.env.GITLAB_REVIEW_JEVV_CONCURRENCY ?? 4);
const SKIP_AGENTIC = process.env.GITLAB_REVIEW_JEVV_SKIP_AGENTIC === '1';
/**
 * Find passes per PR. Real PRs de-saturate hard — one pass over the 16-PR subset
 * yields single-digit severe findings, too few to separate the arms. Extra trials
 * pool independent Find samples (the finder is not deterministic) to grow the
 * verified set, including the fabrications the Verify stage exists to catch.
 */
const TRIALS = Number(process.env.GITLAB_REVIEW_JEVV_TRIALS ?? 1);
/** Model for the correctness judge. Kept separate from the Find model so the judge
 *  is not scoring its own output with its own blind spots. */
const JUDGE_MODEL =
  process.env.GITLAB_REVIEW_JEVV_JUDGE_MODEL ?? 'openrouter/anthropic/claude-sonnet-5';
/** Independent judge samples; a label survives only if they all agree. */
const TRUTH_SAMPLES = Number(process.env.GITLAB_REVIEW_JEVV_TRUTH_SAMPLES ?? 2);
const CACHE = join(RESULTS_DIR, 'jev-verify.json');

type GoldVerdict = 'CONFIRMED' | 'PLAUSIBLE' | 'FABRICATED';

/** Only CRITICAL/WARN reach the Verify stage in production; INFO passes through. */
const isSevere = (s: string): boolean => s === 'critical' || s === 'warn';

interface FindingRecord {
  taskId: string;
  difficulty: string;
  trial: number;
  index: number;
  file: string;
  line: number;
  severity: string;
  confidence: Confidence;
  side: Side;
  body: string;
  /** Gold-comment alignment from matchAndVerdict — kept as a DIAGNOSTIC only. */
  gold?: GoldVerdict;
  /** Ground truth: is this finding's claim actually true of this change? */
  truth?: {
    label: CorrectnessLabel | null;
    agreed: boolean;
    preExisting: boolean;
    cost: number;
    reasons: string[];
  };
  jev?: {
    decision: VerifyDecision;
    confidence: number;
    probabilities: Record<string, number>;
    demonstrable: number;
    latencyMs: number;
    cost: number;
    inputTokens: number;
    clamped: boolean;
    error?: string;
  };
  agentic?: {
    decision: VerifyDecision;
    reason: string;
    latencyMs: number;
    cost: number;
    toolCalls: number;
    error?: string;
  };
}

interface Cache {
  config: { findModel: string; jevModel: string };
  /** Task ids whose Find pass completed — including those that found nothing, so a
   *  quiet PR is not re-reviewed (and re-paid for) on every run. */
  found: string[];
  findings: FindingRecord[];
  findCost: number;
}

async function runBounded<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = Array.from({ length: tasks.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

async function loadCache(): Promise<Cache | null> {
  if (process.env.GITLAB_REVIEW_JEVV_FRESH === '1') return null;
  try {
    const cache = JSON.parse(await readFile(CACHE, 'utf8')) as Cache;
    // A different Find model means different findings; the cache no longer applies.
    return cache.config?.findModel === FIND_MODEL ? cache : null;
  } catch {
    return null;
  }
}

/**
 * The production Verify agent, rebuilt over a frozen finding: the exported prompt
 * builders and the same read-only repo tools, so the baseline differs from
 * production only in that the findings are replayed rather than freshly found.
 */
async function verifyAgentically(
  rec: FindingRecord,
  diff: string,
  repoDir: string,
): Promise<NonNullable<FindingRecord['agentic']>> {
  const run = await runAgentForText({
    systemPrompt: buildVerifySystemPrompt(diff),
    userPrompt: buildVerifyUserPrompt({
      file: rec.file,
      line: rec.line,
      side: rec.side,
      severity: rec.severity as Severity,
      confidence: rec.confidence,
      body: rec.body,
    }),
    model: FIND_MODEL,
    repoDir,
  });
  const base = { latencyMs: run.latencyMs, cost: run.cost, toolCalls: run.toolCalls };
  if (run.error) {
    return { decision: 'keep', reason: 'verifier error; finding kept', ...base, error: run.error };
  }
  try {
    return { ...parseVerdict(run.text), ...base };
  } catch (err) {
    return {
      decision: 'keep',
      reason: 'verifier error; finding kept',
      ...base,
      error: (err as Error).message,
    };
  }
}

const median = (xs: number[]): number => (xs.length ? xs[Math.floor(xs.length / 2)] : 0);

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`;
}

/**
 * What a correct verifier should do with a finding, from the correctness judge.
 * A claim that is true but describes behaviour the diff did not introduce should
 * still be dropped: the Verify stage guards what this change introduces, and
 * scoring it otherwise punishes the refutation that broke the first run.
 * Returns null when the finding cannot serve as ground truth.
 */
function expectedOf(r: FindingRecord): 'keep' | 'drop' | null {
  const t = r.truth;
  if (!t || !t.agreed || t.label === null || t.label === 'UNPROVABLE') return null;
  if (t.label === 'FALSE') return 'drop';
  return t.preExisting ? 'drop' : 'keep';
}

function scoreArm(
  rows: FindingRecord[],
  pick: (r: FindingRecord) => VerifyDecision | undefined,
): { keepOk: number; keepN: number; dropOk: number; dropN: number } {
  let keepOk = 0;
  let keepN = 0;
  let dropOk = 0;
  let dropN = 0;
  for (const r of rows) {
    const d = pick(r);
    const expected = expectedOf(r);
    if (!d || !expected) continue;
    if (expected === 'keep') {
      keepN += 1;
      // A downgrade still publishes the finding, so it counts as surviving.
      if (d !== 'drop') keepOk += 1;
    } else {
      dropN += 1;
      if (d === 'drop') dropOk += 1;
    }
  }
  return { keepOk, keepN, dropOk, dropN };
}

test(
  'jev vs agentic verify on real SWE-PRBench findings',
  async () => {
    if (!jevAvailable()) {
      console.warn('[jev-verify] No OPENROUTER_API_KEY — skipping.');
      return;
    }
    if (!judgeAvailable()) {
      console.warn('[jev-verify] No judge key — skipping.');
      return;
    }
    await mkdir(RESULTS_DIR, { recursive: true });

    const all = await loadInstances({
      only: process.env.GITLAB_REVIEW_JEVV_ONLY,
      limit: Number(process.env.GITLAB_REVIEW_JEVV_LIMIT ?? 0),
    });
    const runnable: Instance[] = [];
    for (const inst of all) if (await isMaterialized(inst.task_id)) runnable.push(inst);
    if (!runnable.length) {
      console.warn('[jev-verify] Nothing materialized; run materialize.mjs first. Skipping.');
      return;
    }

    const cached = await loadCache();
    const records: FindingRecord[] = cached?.findings ?? [];
    let findCost = cached?.findCost ?? 0;
    const found = new Set(cached?.found ?? []);
    const serialize = (): string =>
      JSON.stringify(
        {
          config: { findModel: FIND_MODEL, jevModel: JEV_MODEL, judgeModel: JUDGE_MODEL },
          found: [...found],
          findings: records,
          findCost,
        },
        null,
        2,
      );

    // --- Phase 1+2: Find, then label against gold. Frozen once per (PR, trial). ---
    const passes = runnable.flatMap((inst) =>
      Array.from({ length: TRIALS }, (_, trial) => ({ inst, trial })),
    );
    const todo = passes.filter(({ inst, trial }) => !found.has(`${inst.task_id}|${trial}`));
    if (todo.length) {
      console.log(`[jev-verify] find+label on ${todo.length} pass(es) with ${FIND_MODEL}…`);
      const produced = await runBounded(
        todo.map(({ inst, trial }) => async () => {
          const out = await runReviewer(inst, repoDirFor(inst.task_id), {
            model: FIND_MODEL,
            depth: 'single',
            thinking: 'medium',
          });
          if (out.error) {
            console.warn(`[jev-verify] ${inst.task_id} trial ${trial} find failed: ${out.error}`);
            return { inst, trial, findings: [] as OurFinding[], cost: 0, match: null };
          }
          const match = await matchAndVerdict(inst, out.findings);
          return { inst, trial, findings: out.findings, cost: out.costTotal, match };
        }),
        Math.min(CONCURRENCY, 3),
      );

      for (const { inst, trial, findings, cost, match } of produced) {
        findCost += cost;
        found.add(`${inst.task_id}|${trial}`);
        findings.forEach((f, index) => {
          records.push({
            taskId: inst.task_id,
            difficulty: inst.difficulty,
            trial,
            index,
            file: f.file,
            line: f.line,
            severity: f.severity,
            confidence: f.confidence ?? 'high',
            side: f.side ?? 'RIGHT',
            body: f.body,
            gold: match?.findings?.find((v) => v.i === index)?.verdict,
          });
        });
      }
      await writeFile(CACHE, serialize());
    }

    const severe = records.filter((r) => isSevere(r.severity));
    if (!severe.length) {
      console.warn('[jev-verify] Find produced no severe findings — nothing to verify.');
      return;
    }
    const diffOf = new Map(runnable.map((i) => [i.task_id, i.diff_patch]));

    // --- Phase 2b: correctness judge — the ground truth the arms are scored on. ---
    const needTruth = severe.filter((r) => !r.truth);
    if (needTruth.length) {
      console.log(`[jev-verify] judging correctness of ${needTruth.length} finding(s)…`);
      await runBounded(
        needTruth.map((rec) => async () => {
          const result = await judgeFindingCorrectness({
            diff: diffOf.get(rec.taskId) ?? '',
            finding: rec,
            repoDir: repoDirFor(rec.taskId),
            model: JUDGE_MODEL,
            samples: TRUTH_SAMPLES,
          });
          rec.truth = {
            label: result.label,
            agreed: result.agreed,
            preExisting: result.preExisting,
            cost: result.cost,
            reasons: result.samples.map((x) => x.reason),
          };
          if (result.errors.length) {
            console.warn(`[jev-verify] judge errors on ${rec.file}: ${result.errors.join('; ')}`);
          }
        }),
        Math.min(CONCURRENCY, 3),
      );
      await writeFile(CACHE, serialize());
    }

    // --- Phase 3: Jev. ---
    const needJev = severe.filter((r) => !r.jev);
    if (needJev.length) {
      console.log(`[jev-verify] asking Jev on ${needJev.length} finding(s)…`);
      await runBounded(
        needJev.map((rec) => async () => {
          const diff = diffOf.get(rec.taskId) ?? '';
          const { state, clamped } = buildJevVerifyState({ diff, ...rec });
          try {
            const { response, latencyMs } = await askJev(state, VERIFY_QUESTIONS);
            const parsed = parseJevVerdict(response);
            rec.jev = {
              ...parsed,
              latencyMs,
              clamped,
              cost: response.usage.cost,
              inputTokens: response.usage.input_tokens,
            };
          } catch (err) {
            rec.jev = {
              decision: 'keep',
              confidence: 0,
              probabilities: {},
              demonstrable: Number.NaN,
              latencyMs: 0,
              clamped,
              cost: 0,
              inputTokens: 0,
              error: (err as Error).message,
            };
          }
        }),
        CONCURRENCY,
      );
    }

    // --- Phase 4: agentic baseline over the same findings. ---
    const needAgentic = SKIP_AGENTIC ? [] : severe.filter((r) => !r.agentic);
    if (needAgentic.length) {
      console.log(`[jev-verify] agentic verify on ${needAgentic.length} finding(s)…`);
      await runBounded(
        needAgentic.map((rec) => async () => {
          rec.agentic = await verifyAgentically(
            rec,
            diffOf.get(rec.taskId) ?? '',
            repoDirFor(rec.taskId),
          );
        }),
        Math.min(CONCURRENCY, 3),
      );
    }

    await writeFile(CACHE, serialize());

    // --- Report. ---
    // Scored set: findings the correctness judge could settle unanimously.
    const labelled = severe.filter((r) => expectedOf(r) !== null);
    const jevScore = scoreArm(labelled, (r) => (r.jev?.error ? undefined : r.jev?.decision));
    const agScore = scoreArm(labelled, (r) => (r.agentic?.error ? undefined : r.agentic?.decision));

    const jevCost = severe.reduce((a, r) => a + (r.jev?.cost ?? 0), 0);
    const jevLat = severe.map((r) => r.jev?.latencyMs ?? 0).toSorted((a, b) => a - b);
    const agLat = severe
      .map((r) => r.agentic?.latencyMs ?? 0)
      .filter((n) => n > 0)
      .toSorted((a, b) => a - b);

    // Agreement between the two arms, and the pre-filter question: how often is
    // Jev both confident AND right, i.e. how much of the agentic spend it could save.
    const bothRan = severe.filter((r) => r.jev && !r.jev.error && r.agentic && !r.agentic.error);
    const agree = bothRan.filter((r) => r.jev!.decision === r.agentic!.decision).length;

    const thresholds = [0.5, 0.6, 0.7, 0.8, 0.9];
    const sweep = thresholds.map((t) => {
      const confident = labelled.filter((r) => r.jev && !r.jev.error && r.jev.confidence >= t);
      const s = scoreArm(confident, (r) => r.jev?.decision);
      const ok = s.keepOk + s.dropOk;
      const n = s.keepN + s.dropN;
      return {
        t,
        covered: confident.length,
        share: severe.length ? confident.length / severe.length : 0,
        ok,
        n,
      };
    });

    const truthCost = severe.reduce((a, r) => a + (r.truth?.cost ?? 0), 0);
    const shouldKeep = labelled.filter((r) => expectedOf(r) === 'keep').length;
    const shouldDrop = labelled.length - shouldKeep;
    const unsettled = severe.length - labelled.length;
    const split = severe.filter((r) => r.truth && !r.truth.agreed).length;
    const preExisting = severe.filter((r) => r.truth?.preExisting).length;

    // Quantifies why the gold-comment labels could not score a verifier: how often
    // matchAndVerdict's verdict contradicts what the claim-level judge found.
    const confusion = (['CONFIRMED', 'PLAUSIBLE', 'FABRICATED'] as GoldVerdict[]).map((g) => {
      const rows = labelled.filter((r) => r.gold === g);
      return {
        gold: g,
        keep: rows.filter((r) => expectedOf(r) === 'keep').length,
        drop: rows.filter((r) => expectedOf(r) === 'drop').length,
      };
    });

    const md = [
      '# Jev vs agentic Verify — SWE-PRBench (real findings)',
      '',
      `- Find model: \`${FIND_MODEL}\` (depth single, thinking medium), Find cost $${findCost.toFixed(4)}`,
      `- Jev model: \`${JEV_MODEL}\` via OpenRouter \`/api/alpha/decisions\``,
      `- PRs: ${runnable.length} × ${TRIALS} trial(s) · findings: ${records.length} · severe (verified): ${severe.length}`,
      `- Correctness judge: \`${JUDGE_MODEL}\` × ${TRUTH_SAMPLES} samples (unanimous only), cost $${truthCost.toFixed(4)}`,
      `- Scored: ${labelled.length}/${severe.length} — should keep ${shouldKeep} · should drop ${shouldDrop}`,
      `- Unsettled: ${unsettled} (${split} split votes, rest UNPROVABLE) · claims about pre-existing behaviour: ${preExisting}`,
      '',
      '## Accuracy against the correctness judge',
      '',
      '| arm | keeps true findings | drops false/pre-existing | overall |',
      '| --- | --- | --- | --- |',
      `| Jev | ${jevScore.keepOk}/${jevScore.keepN} (${pct(jevScore.keepOk, jevScore.keepN)}) | ${jevScore.dropOk}/${jevScore.dropN} (${pct(jevScore.dropOk, jevScore.dropN)}) | ${pct(jevScore.keepOk + jevScore.dropOk, jevScore.keepN + jevScore.dropN)} |`,
      `| agentic | ${agScore.keepOk}/${agScore.keepN} (${pct(agScore.keepOk, agScore.keepN)}) | ${agScore.dropOk}/${agScore.dropN} (${pct(agScore.dropOk, agScore.dropN)}) | ${pct(agScore.keepOk + agScore.dropOk, agScore.keepN + agScore.dropN)} |`,
      '',
      '## Cost and latency (Verify stage only)',
      '',
      `- Jev: $${jevCost.toFixed(6)} total, median ${median(jevLat)}ms`,
      `- agentic: median ${median(agLat)}ms${SKIP_AGENTIC ? ' (skipped)' : ''}`,
      `- agreement between arms: ${agree}/${bothRan.length} (${pct(agree, bothRan.length)})`,
      '',
      '## Gold-comment label vs claim-level truth',
      '',
      'Why `matchAndVerdict` cannot score a verifier: its verdict answers "does this',
      'match a human comment", not "is this claim true".',
      '',
      '| matchAndVerdict said | judge: should keep | judge: should drop |',
      '| --- | --- | --- |',
      ...confusion.map((c) => `| ${c.gold} | ${c.keep} | ${c.drop} |`),
      '',
      '## Confidence threshold — how much Jev could decide alone',
      '',
      '| min confidence | findings covered | share of severe | accuracy on covered |',
      '| --- | --- | --- | --- |',
      ...sweep.map(
        (s) =>
          `| ${s.t.toFixed(1)} | ${s.covered} | ${(s.share * 100).toFixed(0)}% | ${s.ok}/${s.n} (${pct(s.ok, s.n)}) |`,
      ),
      '',
      '## Disagreements',
      '',
      '| task | trial | file:line | sev | expected | gold | jev | conf | agentic |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...bothRan
        .filter((r) => r.jev!.decision !== r.agentic!.decision)
        .map(
          (r) =>
            `| ${r.taskId} | ${r.trial} | ${r.file}:${r.line} | ${r.severity} | ${expectedOf(r) ?? '-'} | ${r.gold ?? '-'} | ${r.jev!.decision} | ${r.jev!.confidence.toFixed(2)} | ${r.agentic!.decision} |`,
        ),
      '',
    ].join('\n');

    await writeFile(join(RESULTS_DIR, 'jev-verify.md'), md);
    console.log(`\n${md}`);

    // The eval measures; it asserts only that the pipeline actually produced data.
    expect(severe.length).toBeGreaterThan(0);
    expect(severe.filter((r) => r.jev && !r.jev.error).length).toBeGreaterThan(0);
  },
  60 * 60_000,
);
