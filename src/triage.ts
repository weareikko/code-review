import type { Confidence, ReviewComment, Severity } from './types.js';

/**
 * A Find "angle" — one lens a finder is specialised to. `full` depth runs one
 * finder per angle (concurrently) so each can go deep in its lane; Triage then
 * merges and deduplicates their findings.
 */
export interface ReviewAngle {
  key: string;
  directive: string;
}

export const REVIEW_ANGLES: readonly ReviewAngle[] = [
  {
    key: 'correctness',
    directive:
      'Focus on logic and control-flow correctness: inverted, too-broad, or too-narrow conditions; off-by-one and boundary errors; wrong defaults; branches that collapse distinct cases (0, false, "", null, undefined, missing); unreachable code; and edge cases (empty, first, last, duplicate, overflow, timezone). Trace the changed logic against its intended contract.',
  },
  {
    key: 'state-async-data',
    directive:
      'Focus on state, concurrency, and data integrity: unawaited promises; race conditions and ordering bugs; cleanup in the wrong order; shared, mutable, or global state leaking across callers; cache key/scope mistakes; and runtime values that no longer match schemas, public types, API shapes, serialization, or persistence contracts.',
  },
  {
    key: 'failure-security',
    directive:
      'Focus on failure handling and security: swallowed, converted, or partial errors that leave callers believing work succeeded; unsafe retries; missing or broken auth/permission checks; injection, SSRF, or path traversal; secret handling; and resource exhaustion (unbounded growth, missing limits) on reachable paths.',
  },
];

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * Normalise a comment's subject (the text after the Conventional Comment label
 * on the first line) for duplicate detection: lowercase, strip punctuation,
 * collapse whitespace.
 */
function normalizeSubject(body: string): string {
  const first = (body.split('\n', 1)[0] ?? '').toLowerCase();
  const subject = first.includes(':') ? first.slice(first.indexOf(':') + 1) : first;
  return subject
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Merge findings from multiple angle finders into a deduplicated set. Two
 * findings are considered the same when they share file, line, and normalised
 * subject; the higher-severity copy wins (ties broken by higher confidence) so
 * a finding one angle rates CRITICAL is not masked by another angle's WARN.
 */
export function triageFindings(groups: ReviewComment[][]): ReviewComment[] {
  const byKey = new Map<string, ReviewComment>();
  for (const group of groups) {
    for (const comment of group) {
      const key = `${comment.file}:${comment.line}:${normalizeSubject(comment.body)}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, comment);
        continue;
      }
      const higherSeverity = SEVERITY_RANK[comment.severity] > SEVERITY_RANK[existing.severity];
      const sameSeverityHigherConfidence =
        SEVERITY_RANK[comment.severity] === SEVERITY_RANK[existing.severity] &&
        CONFIDENCE_RANK[comment.confidence] > CONFIDENCE_RANK[existing.confidence];
      if (higherSeverity || sameSeverityHigherConfidence) {
        byKey.set(key, comment);
      }
    }
  }
  return [...byKey.values()];
}
