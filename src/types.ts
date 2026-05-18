export type Severity = 'info' | 'warn' | 'critical';
export type PiReviewerSeverity = 'INFO' | 'WARN' | 'CRITICAL';
export type Side = 'RIGHT' | 'LEFT';

export interface ReviewComment {
  file: string;
  line: number;
  side: Side;
  severity: Severity;
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

export function toPiReviewerSeverity(severity: Severity): PiReviewerSeverity {
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
