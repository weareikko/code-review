export type Severity = 'info' | 'warn' | 'critical';
export type GitLabReviewSeverity = 'INFO' | 'WARN' | 'CRITICAL';
export type Confidence = 'high' | 'medium' | 'low';
export type Side = 'RIGHT' | 'LEFT';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * How many stages of the review pipeline run.
 * - `single`: one Find pass; the model's output is used verbatim (legacy behaviour).
 * - `verify`: Find → Verify → Synthesize; each severe finding is re-checked by a
 *   separate adversarial agent before it survives into the posted review.
 * - `full`: multi-angle Find (several finders, each a different lens) → Triage
 *   (dedup) → Verify → Synthesize.
 */
export type ReviewDepth = 'single' | 'verify' | 'full';

export const REVIEW_DEPTHS: readonly ReviewDepth[] = ['single', 'verify', 'full'];

/**
 * How the change is presented to the reviewer agent.
 *
 * - `auto` (default): review inline while the diff fits the char budget, and
 *   switch to `disk` once it overflows. Evals show inline's retrieval fallback is
 *   under-used on large diffs, where disk is both more thorough and cheaper.
 * - `inline`: the diff is embedded in the prompt (size-dropped files are still
 *   staged on disk and referenced).
 * - `disk`: nothing is inlined — every non-noise file diff is staged on disk and
 *   the prompt carries only the file list; the agent reads what it deems risky.
 * - `commits`: nothing is inlined — the prompt points the agent at read-only git
 *   tools (`git_log`/`git_show`/`git_diff`) to explore the change commit by
 *   commit, optionally scoped to the commits since the last reviewed one.
 */
export type ReviewInputMode = 'auto' | 'inline' | 'disk' | 'commits';

export const REVIEW_INPUT_MODES: readonly ReviewInputMode[] = ['auto', 'inline', 'disk', 'commits'];

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

export interface ReviewComment {
  file: string;
  line: number;
  side: Side;
  severity: Severity;
  /**
   * The reviewer's certainty that the finding is a real defect, separate from
   * its impact (encoded in `severity`). Defaults to 'high' when absent so
   * legacy reviewer outputs continue to parse unchanged.
   */
  confidence: Confidence;
  body: string;
}

/**
 * A file dropped from the reviewed diff because the cumulative diff exceeded the
 * char budget (distinct from quiet noise skips like lockfiles). `chars` is the
 * size of that file's diff section.
 */
export interface SizeSkippedFile {
  path: string;
  chars: number;
  /** Added/removed lines in this file's dropped diff — feeds the coverage ratio. */
  changedLines: number;
}

export interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

export interface Fingerprints {
  primary: string;
  secondary: string;
}

/**
 * A parsed reviewer finding paired with its dedup fingerprints and the
 * platform-specific posting payload. `payload` is generic (defaulting to
 * `unknown`) so the seam stays platform-agnostic: only the platform that built
 * a payload reads it back. GitLab builds a {@link GitLabDiscussionPayload}.
 */
export interface GeneratedComment<Payload = unknown> {
  comment: ReviewComment;
  fingerprints: Fingerprints;
  duplicate: boolean;
  payload: Payload;
}

export interface GitLabDiscussionPayload {
  body: string;
  position: {
    position_type: 'text';
    base_sha: string;
    start_sha: string;
    head_sha: string;
    old_path: string;
    new_path: string;
    old_line?: number;
    new_line?: number;
  };
}

export function toGitLabReviewSeverity(severity: Severity): GitLabReviewSeverity {
  return severity === 'critical' ? 'CRITICAL' : severity === 'warn' ? 'WARN' : 'INFO';
}

export function normalizeSeverity(value: unknown): Severity {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'critical' || normalized === 'error') return 'critical';
  if (normalized === 'warn' || normalized === 'warning') return 'warn';
  return 'info';
}

/**
 * Normalize a raw confidence value from reviewer JSON into the strict enum.
 * Defaults to 'high' for absent / unrecognised values: a missing field is
 * assumed to come from a pre-confidence reviewer output, and the reviewer
 * historically only emitted findings it considered provable, which maps to
 * high confidence.
 */
export function normalizeConfidence(value: unknown): Confidence {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'low') return 'low';
  if (normalized === 'medium' || normalized === 'med') return 'medium';
  return 'high';
}

/**
 * Split a `"provider/modelId"` model string on the FIRST slash. Multi-slash
 * model IDs (e.g. `openrouter/anthropic/claude-3`) keep everything after the
 * first slash as the model ID. When the string has no slash, `provider` is
 * `undefined` and `modelId` is the whole string (or `undefined` when empty).
 */
export function splitModel(model: string): {
  provider: string | undefined;
  modelId: string | undefined;
} {
  const idx = model.indexOf('/');
  if (idx < 0) return { provider: undefined, modelId: model || undefined };
  return { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
}
