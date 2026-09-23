/**
 * Per-finding correctness judge — ground truth for evaluating a VERIFIER.
 *
 * `matchAndVerdict` in swe-prbench-lib.ts labels a finding by whether it lines
 * up with a human gold comment. That answers "did we find what the reviewer
 * found", which is the right question for RECALL and the wrong one for
 * precision: a correct finding no human happened to mention is scored
 * FABRICATED, and a finding that merely lands on the same line as a gold
 * comment is scored CONFIRMED even when its stated mechanism is wrong. Both
 * errors showed up in the first jev-verify run and made its accuracy column
 * meaningless.
 *
 * This judge asks the only question that can score a verifier: is the specific
 * claim this finding makes TRUE of this change? It gets read-only access to the
 * materialized checkout, because the decisive question is usually whether the
 * surrounding code actually behaves as claimed.
 *
 * It separately reports `preExisting`, because the failure that broke the first
 * run was findings blaming a diff for behaviour that predates it — technically
 * accurate about the code, but not a defect this change introduces. A verifier
 * that drops those is right, and must not be scored wrong for it.
 *
 * Labels are only trustworthy where independent samples agree; `judgeConsensus`
 * keeps agreement and marks the rest ambiguous rather than guessing.
 *
 * MEASURED LIMIT — this judge is NOT yet reliable enough to score a verifier.
 * On the first 41-finding run it labelled 37/39 "should keep", and it contradicted
 * itself on `pre_existing` across findings making the SAME claim about the SAME
 * code: node-postgres__3547 replaces `return config[key] || envVar || defaults[key]`
 * with an early `if (config[key]) return config[key]`, which is identical for falsy
 * values. Judging that claim it answered pre_existing=true once and false twice.
 *
 * The unanimity check does not catch this: two samples of ONE finding share a
 * prompt and tend to agree, so agreement measures sampling noise, not correctness.
 * Catching it needs independent FRAMINGS (e.g. asking "what did this diff change
 * about X" separately from "is this finding true"), or a second judge family, or
 * a human-labelled seed set to calibrate against. Until then, treat the accuracy
 * table as directional and read the reasons.
 */
import { runAgentForText } from './agent-runner.js';

export type CorrectnessLabel = 'TRUE' | 'FALSE' | 'UNPROVABLE';

export interface Judgement {
  label: CorrectnessLabel;
  /** The claimed behaviour predates this diff, so the change does not introduce it. */
  preExisting: boolean;
  /** Concrete input/state/path that triggers the defect; empty when none was shown. */
  trigger: string;
  reason: string;
}

export interface JudgedFinding {
  file: string;
  line: number;
  severity: string;
  body: string;
}

const MAX_DIFF_CHARS = 24_000;

export function buildCorrectnessSystemPrompt(diff: string): string {
  const clamped =
    diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n…[truncated]` : diff;
  return [
    'You adjudicate whether a single code-review finding is FACTUALLY CORRECT about a change.',
    'You are not reviewing the code and not deciding whether the finding is worth posting.',
    'You decide one thing: is the specific claim the finding makes true?',
    '',
    'Judge the stated mechanism, not the topic. A finding that points at the right line but',
    'describes the wrong cause, the wrong trigger, or an effect that cannot occur is FALSE.',
    '',
    'You have read-only tools over the checkout. Use them — the deciding question is usually',
    'whether the surrounding code behaves as the finding claims. Check the real definitions,',
    'callers and guards rather than assuming.',
    '',
    'Answer these in order:',
    '1. Does the code do what the finding says it does?',
    '2. Is there a concrete input, state or execution path that produces the claimed effect?',
    '3. Did THIS diff introduce the behaviour, or did it already behave that way before?',
    '',
    'Labels:',
    '- TRUE: the claim holds and you can name the triggering input/state/path.',
    '- FALSE: the claim is wrong — the code does not do this, a guard prevents it, the',
    '  described effect cannot occur, or an in-file comment documents it as intended.',
    '- UNPROVABLE: you cannot settle it from the diff and the files you can read. Use this',
    '  honestly; do not guess a side.',
    '',
    'Set pre_existing to true when the behaviour the finding describes is unchanged by this',
    'diff — the claim may still be TRUE about the code, but the change did not introduce it.',
    '',
    'Return EXACTLY one JSON object and nothing else — no prose, no markdown fences:',
    '{"label":"TRUE"|"FALSE"|"UNPROVABLE","pre_existing":true|false,"trigger":"<concrete input/state/path, or empty>","reason":"<one sentence>"}',
    '',
    `The change under review:\n<diff>\n${clamped}\n</diff>`,
  ].join('\n');
}

export function buildCorrectnessUserPrompt(finding: JudgedFinding): string {
  return [
    '<finding>',
    `File: ${finding.file}:${finding.line}`,
    `Severity: ${finding.severity.toUpperCase()}`,
    '',
    finding.body,
    '</finding>',
    '',
    'Return the JSON judgement now.',
  ].join('\n');
}

const LABELS = new Set<string>(['TRUE', 'FALSE', 'UNPROVABLE']);

export function parseJudgement(text: string): Judgement {
  const match = text.replaceAll(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON object in judge output: ${text.slice(0, 200)}`);
  const raw = JSON.parse(match[0]) as Record<string, unknown>;
  const label = String(raw.label ?? '').toUpperCase();
  if (!LABELS.has(label)) throw new Error(`unknown correctness label: ${String(raw.label)}`);
  return {
    label: label as CorrectnessLabel,
    preExisting: raw.pre_existing === true,
    trigger: typeof raw.trigger === 'string' ? raw.trigger : '',
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  };
}

export interface ConsensusResult {
  /** Null when the samples disagreed — the finding is then unusable as ground truth. */
  label: CorrectnessLabel | null;
  /** True only when every sample that returned a label agreed. */
  agreed: boolean;
  /** Majority view of pre_existing among agreeing samples. */
  preExisting: boolean;
  samples: Judgement[];
}

/**
 * Keep a label only when every successful sample agrees. A single LLM judge has
 * the same blind spots as the verifier it scores, so a split vote is recorded as
 * ambiguous rather than resolved by majority — the eval excludes those instead
 * of scoring a verifier against a coin flip.
 */
export function judgeConsensus(samples: Judgement[]): ConsensusResult {
  if (samples.length === 0) return { label: null, agreed: false, preExisting: false, samples };
  const labels = new Set(samples.map((s) => s.label));
  const agreed = labels.size === 1;
  const preExisting = samples.filter((s) => s.preExisting).length * 2 > samples.length;
  return { label: agreed ? samples[0].label : null, agreed, preExisting, samples };
}

export interface JudgeOptions {
  diff: string;
  finding: JudgedFinding;
  repoDir: string;
  model: string;
  /** Independent samples to draw; a label survives only on unanimous agreement. */
  samples?: number;
}

export async function judgeFindingCorrectness(
  options: JudgeOptions,
): Promise<ConsensusResult & { cost: number; errors: string[] }> {
  const systemPrompt = buildCorrectnessSystemPrompt(options.diff);
  const userPrompt = buildCorrectnessUserPrompt(options.finding);
  const runs = await Promise.all(
    Array.from({ length: options.samples ?? 2 }, () =>
      runAgentForText({
        systemPrompt,
        userPrompt,
        model: options.model,
        repoDir: options.repoDir,
        thinkingLevel: 'low',
      }),
    ),
  );

  const samples: Judgement[] = [];
  const errors: string[] = [];
  let cost = 0;
  for (const run of runs) {
    cost += run.cost;
    if (run.error) {
      errors.push(run.error);
      continue;
    }
    try {
      samples.push(parseJudgement(run.text));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { ...judgeConsensus(samples), cost, errors };
}
