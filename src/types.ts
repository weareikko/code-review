export type Severity = 'info' | 'warn' | 'critical';
export type GitLabReviewSeverity = 'INFO' | 'WARN' | 'CRITICAL';
export type Confidence = 'high' | 'medium' | 'low';
export type Side = 'RIGHT' | 'LEFT';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

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

export interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

export interface Fingerprints {
  primary: string;
  secondary: string;
}

export interface GeneratedComment {
  comment: ReviewComment;
  fingerprints: Fingerprints;
  duplicate: boolean;
  payload: GitLabDiscussionPayload;
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
  if (normalized === 'critical' || normalized === 'error' || normalized === '🔴') return 'critical';
  if (normalized === 'warn' || normalized === 'warning' || normalized === '🟡') return 'warn';
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
