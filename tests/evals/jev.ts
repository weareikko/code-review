/**
 * Minimal client for TypeSafe's Jev decision model, reached through OpenRouter.
 *
 * Jev is not a chat model: OpenRouter rejects it on `/chat/completions` and
 * routes it through `/api/alpha/decisions` instead. It takes unstructured
 * `state` plus a map of typed questions and returns one typed answer per
 * question with a calibrated probability distribution — no text, no tools.
 *
 * Used by `jev-verify.eval.ts` to ask whether Jev can stand in for the Verify
 * stage's keep/downgrade/drop decision. The endpoint is alpha and the model is
 * in beta, so nothing in `src/` depends on this.
 */
import type { VerifyDecision } from '../../src/verify.js';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

/** Pinned rather than `jev-latest`, so a model refresh cannot silently move results. */
export const JEV_MODEL = process.env.GITLAB_REVIEW_JEV_MODEL ?? 'typesafe/jev-1.13';

/**
 * Jev's context is 32k. Diffs in the SWE-PRBench subset run past that, so they
 * are clamped and the clamp is recorded on the record rather than hidden.
 */
export const JEV_MAX_DIFF_CHARS = 24_000;

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  id: string;
  provider: string;
}

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string };

export function jevAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export async function askJev(
  state: string,
  questions: Record<string, JevQuestion>,
): Promise<{ response: JevResponse; latencyMs: number }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is required to call Jev');

  const started = Date.now();
  const res = await fetch(DECISIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
  });
  const latencyMs = Date.now() - started;
  const body = (await res.json()) as JevResponse & { error?: { message: string } };
  if (!res.ok || body.error) {
    throw new Error(
      `Jev ${res.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return { response: body, latencyMs };
}

/**
 * The adversarial bar from `buildVerifySystemPrompt`, restated as a question.
 * Production states it as a system prompt ending in "return one JSON object";
 * Jev needs no output contract, so only the judgement criteria carry over.
 */
const VERIFY_INSTRUCTIONS = [
  'You are a strict, adversarial verifier of a SINGLE code-review finding.',
  'Your job is to REFUTE the finding, not to agree with it.',
  'The finding must point to a concrete defect demonstrable from the diff: a specific input,',
  'state, or execution path triggers it, and a violated contract is visible.',
  'A finding you cannot prove is wrong — default to refuting when the failure path is not demonstrable.',
  'A CRITICAL finding MUST prove a reachable failure path; if it cannot, it is not CRITICAL.',
  'An in-file comment, commit message, or prior decision that justifies the pattern refutes a',
  'finding that ignores it.',
  'Does this finding survive scrutiny?',
].join(' ');

/** Keys are exactly {@link VerifyDecision}; the text mirrors the production prompt. */
export const VERIFY_CRITERIA: Record<VerifyDecision, string> = {
  keep: 'The finding is proven at its stated severity: a specific input, state or execution path triggers it and a violated contract is visible in the code.',
  downgrade:
    'A real concern, but the stated severity overstates a demonstrable impact — e.g. a CRITICAL whose failure path is not proven, or a WARN that is really a nit.',
  drop: 'Not a real defect — speculative, stylistic, contradicted by the code or an in-file comment, or based on external state not visible in the diff.',
};

/**
 * A second, narrower gate. The choice answer alone conflates "this is not a bug"
 * with "I cannot see enough to tell"; this separates them, and on the fixture
 * probe it split far more cleanly than the choice confidence did.
 */
const DEMONSTRABLE_INSTRUCTIONS =
  'Is the failure path this finding describes demonstrable from the diff alone, with no reliance on external state, other files, or documentation not shown?';

export const VERIFY_QUESTIONS: Record<string, JevQuestion> = {
  verdict: { type: 'choice', instructions: VERIFY_INSTRUCTIONS, criteria: VERIFY_CRITERIA },
  demonstrable: { type: 'noul', instructions: DEMONSTRABLE_INSTRUCTIONS },
};

export interface JevVerifyInput {
  diff: string;
  file: string;
  line: number;
  severity: string;
  confidence: string;
  body: string;
  commitLog?: string;
}

/** Mirrors `buildVerifySystemPrompt` + `buildVerifyUserPrompt`, flattened into one state blob. */
export function buildJevVerifyState(input: JevVerifyInput): { state: string; clamped: boolean } {
  const clamped = input.diff.length > JEV_MAX_DIFF_CHARS;
  const diff = clamped ? `${input.diff.slice(0, JEV_MAX_DIFF_CHARS)}\n…[truncated]` : input.diff;
  const parts = [`<diff>\n${diff}\n</diff>`];
  if (input.commitLog?.trim()) {
    parts.push('', `<commits>\n${input.commitLog.trim()}\n</commits>`);
  }
  parts.push(
    '',
    '<finding>',
    `File: ${input.file}:${input.line}`,
    `Severity: ${input.severity.toUpperCase()} (confidence: ${input.confidence})`,
    '',
    input.body,
    '</finding>',
  );
  return { state: parts.join('\n'), clamped };
}

export function parseJevVerdict(response: JevResponse): {
  decision: VerifyDecision;
  confidence: number;
  probabilities: Record<string, number>;
  demonstrable: number;
} {
  const verdict = response.answers.verdict;
  const demonstrable = response.answers.demonstrable;
  if (verdict?.type !== 'choice') throw new Error('Jev returned no choice answer for "verdict"');
  if (!(verdict.choice in VERIFY_CRITERIA)) {
    throw new Error(`Jev returned an unknown decision: ${verdict.choice}`);
  }
  return {
    decision: verdict.choice as VerifyDecision,
    confidence: verdict.confidence,
    probabilities: verdict.probabilities,
    demonstrable: demonstrable?.type === 'noul' ? demonstrable.noul : Number.NaN,
  };
}
