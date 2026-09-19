/**
 * Jev as a dedup tool for the Triage stage.
 *
 * `triageFindings` merges multi-angle findings with a token-set Jaccard over
 * normalised subject lines (`SUBJECT_SIMILARITY_THRESHOLD`), which the code
 * itself flags as "fuzzy dedup for heterogeneous phrasings". Whether two
 * findings describe the same defect is a semantic judgement, and Jaccard is a
 * bag-of-words proxy for it — so this measures the heuristic against a Jev
 * `noul` question on the same pairs.
 *
 * Unlike jev-verify.eval.ts, this needs NO correctness ground truth. "Are these
 * the same issue?" is adjudicable by reading the two findings, independent of
 * whether either is true — which is why this one can be settled while the
 * verifier question stays blocked on labels.
 *
 * The fixture is 36 hand-labelled pairs drawn from the jev-verify run: findings
 * from independent Find passes over the same PR, which rediscover the same
 * defects in different words. Every pair already passes Triage's file +
 * `MAX_LINE_DELTA` gate, so only the subject-similarity step is under test.
 *
 * Writes test-results/jev-dedup.{json,md}. Needs OPENROUTER_API_KEY.
 * Env: GITLAB_REVIEW_JEV_MODEL, GITLAB_REVIEW_JEVD_CONCURRENCY.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { areSameFinding } from '../../src/triage.js';
import type { Confidence, ReviewComment, Severity } from '../../src/types.js';
import { askJev, jevAvailable, JEV_MODEL, type JevQuestion } from './jev.js';
import { RESULTS_DIR } from './swe-prbench-lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'dedup-pairs.json');
const CONCURRENCY = Number(process.env.GITLAB_REVIEW_JEVD_CONCURRENCY ?? 6);

interface PairSide {
  line: number;
  severity: string;
  confidence: string;
  body: string;
}

interface LabelledPair {
  taskId: string;
  file: string;
  /** Hand-labelled: do these two findings describe the same underlying defect? */
  duplicate: boolean;
  a: PairSide;
  b: PairSide;
}

const DEDUP_QUESTION: Record<string, JevQuestion> = {
  same_issue: {
    type: 'noul',
    instructions:
      'Do these two code-review findings describe the SAME underlying defect? Answer high when they point at one problem in different words, even if the wording, the suggested fix, or the emphasis differs. Answer low when they describe genuinely different problems that happen to sit in the same file and nearby lines. Judge the defect, not the phrasing, and ignore whether either finding is actually correct.',
  },
};

/** Threshold on Jev's probability; swept in the report, this is the headline cut. */
const JEV_THRESHOLD = 0.5;

function toComment(side: PairSide, file: string): ReviewComment {
  return {
    file,
    line: side.line,
    side: 'RIGHT',
    severity: side.severity as Severity,
    confidence: side.confidence as Confidence,
    body: side.body,
  };
}

function buildState(pair: LabelledPair): string {
  return [
    `Both findings are on \`${pair.file}\` in the same change.`,
    '',
    '<finding_a>',
    `Line ${pair.a.line} (${pair.a.severity.toUpperCase()})`,
    pair.a.body.trim(),
    '</finding_a>',
    '',
    '<finding_b>',
    `Line ${pair.b.line} (${pair.b.severity.toUpperCase()})`,
    pair.b.body.trim(),
    '</finding_b>',
  ].join('\n');
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

interface Scored {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

function score(rows: Array<{ duplicate: boolean; merged: boolean }>): Scored {
  const s: Scored = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const r of rows) {
    if (r.duplicate && r.merged) s.tp += 1;
    else if (r.duplicate) s.fn += 1;
    else if (r.merged) s.fp += 1;
    else s.tn += 1;
  }
  return s;
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`);

/** Precision matters more than recall here: a wrong merge silently deletes a real finding. */
function line(name: string, s: Scored): string {
  return `| ${name} | ${s.tp}/${s.tp + s.fn} (${pct(s.tp, s.tp + s.fn)}) | ${pct(s.tp, s.tp + s.fp)} | ${s.fp} | ${s.fn} |`;
}

test(
  'jev vs jaccard for triage dedup',
  async () => {
    if (!jevAvailable()) {
      console.warn('[jev-dedup] No OPENROUTER_API_KEY — skipping.');
      return;
    }
    await mkdir(RESULTS_DIR, { recursive: true });
    const pairs = JSON.parse(await readFile(FIXTURE, 'utf8')) as LabelledPair[];

    const results = await runBounded(
      pairs.map((pair) => async () => {
        const heuristic = areSameFinding(
          toComment(pair.a, pair.file),
          toComment(pair.b, pair.file),
        );
        try {
          const { response, latencyMs } = await askJev(buildState(pair), DEDUP_QUESTION);
          const answer = response.answers.same_issue;
          if (answer?.type !== 'noul') throw new Error('Jev returned no noul answer');
          return {
            pair,
            heuristic,
            prob: answer.noul,
            latencyMs,
            cost: response.usage.cost,
            error: undefined as string | undefined,
          };
        } catch (err) {
          return {
            pair,
            heuristic,
            prob: Number.NaN,
            latencyMs: 0,
            cost: 0,
            error: (err as Error).message,
          };
        }
      }),
      CONCURRENCY,
    );

    const ok = results.filter((r) => !r.error);
    const jaccardScore = score(
      results.map((r) => ({ duplicate: r.pair.duplicate, merged: r.heuristic })),
    );
    const jevScore = score(
      ok.map((r) => ({ duplicate: r.pair.duplicate, merged: r.prob >= JEV_THRESHOLD })),
    );

    const sweep = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => ({
      t,
      s: score(ok.map((r) => ({ duplicate: r.pair.duplicate, merged: r.prob >= t }))),
    }));

    const cost = results.reduce((a, r) => a + r.cost, 0);
    const lat = ok.map((r) => r.latencyMs).toSorted((a, b) => a - b);
    const dupes = pairs.filter((p) => p.duplicate).length;

    const md = [
      '# Jev vs Jaccard — Triage dedup',
      '',
      `- Pairs: ${pairs.length} (${dupes} duplicates, ${pairs.length - dupes} distinct), hand-labelled`,
      `- Every pair already passes Triage's file + MAX_LINE_DELTA gate; only subject similarity is under test`,
      `- Jev: \`${JEV_MODEL}\`, threshold ${JEV_THRESHOLD}, cost $${cost.toFixed(6)}, median ${lat.length ? lat[Math.floor(lat.length / 2)] : 0}ms`,
      ok.length < results.length ? `- ${results.length - ok.length} Jev call(s) failed` : '',
      '',
      '## Detection',
      '',
      'A false merge silently deletes a real finding, so precision matters more than recall.',
      '',
      '| method | recall on duplicates | precision | false merges | missed duplicates |',
      '| --- | --- | --- | --- | --- |',
      line('Jaccard ≥ 0.6 (current)', jaccardScore),
      line(`Jev ≥ ${JEV_THRESHOLD}`, jevScore),
      '',
      '## Jev threshold sweep',
      '',
      '| threshold | recall | precision | false merges |',
      '| --- | --- | --- | --- |',
      ...sweep.map(
        (x) =>
          `| ${x.t.toFixed(1)} | ${pct(x.s.tp, x.s.tp + x.s.fn)} | ${pct(x.s.tp, x.s.tp + x.s.fp)} | ${x.s.fp} |`,
      ),
      '',
      '## Per-pair',
      '',
      '| task | file:lines | labelled | jaccard | jev p | agree? |',
      '| --- | --- | --- | --- | --- | --- |',
      ...results.map((r) => {
        const merged = r.prob >= JEV_THRESHOLD;
        const mark = r.error ? 'error' : merged === r.pair.duplicate ? '✓' : '✗';
        return `| ${r.pair.taskId} | ${r.pair.file.split('/').pop()}:${r.pair.a.line}/${r.pair.b.line} | ${r.pair.duplicate ? 'duplicate' : 'distinct'} | ${r.heuristic ? 'merge' : 'separate'} | ${Number.isNaN(r.prob) ? '—' : r.prob.toFixed(2)} | ${mark} |`;
      }),
      '',
    ]
      .filter((l) => l !== '')
      .join('\n');

    await writeFile(join(RESULTS_DIR, 'jev-dedup.md'), md);
    await writeFile(
      join(RESULTS_DIR, 'jev-dedup.json'),
      JSON.stringify(
        {
          config: { jevModel: JEV_MODEL, threshold: JEV_THRESHOLD },
          rows: results.map((r) => ({ ...r.pair, heuristic: r.heuristic, prob: r.prob })),
        },
        null,
        2,
      ),
    );
    console.log(`\n${md}`);

    expect(ok.length).toBeGreaterThan(0);
  },
  15 * 60_000,
);
