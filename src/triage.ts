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
 * A finding paired with the pool member that authored it. The author model is
 * internal pipeline metadata used to pick a cross-family verifier (a model other
 * than the one that raised the finding). It MUST NOT leak into posted comments,
 * fingerprints, or the summary — only `comment` is ever surfaced.
 */
export interface AuthoredFinding {
  comment: ReviewComment;
  authorModel: string;
}

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

/** Max line distance at which two findings in the same file may be merged. */
const MAX_LINE_DELTA = 2;
/** Min token-set Jaccard similarity of normalised subjects required to merge. */
const SUBJECT_SIMILARITY_THRESHOLD = 0.6;

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'in',
  'on',
  'of',
  'to',
  'and',
  'or',
  'not',
  'this',
  'that',
  'it',
  'its',
  'be',
  'by',
  'for',
]);

function subjectTokens(subject: string): Set<string> {
  const tokens = subject.split(' ').filter((t) => t && !STOP_WORDS.has(t));
  // Fall back to the raw (non-stopword-filtered) tokens if filtering emptied the
  // set — a subject made entirely of stop words still needs something to compare.
  if (tokens.length === 0) return new Set(subject.split(' ').filter(Boolean));
  return new Set(tokens);
}

/** Token-set Jaccard similarity in [0, 1]; 1 when both sets are empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * True when `candidate` should be merged into the cluster anchored by `anchor`:
 * same file, line within {@link MAX_LINE_DELTA}, and either an identical
 * normalised subject (exact dedup) or a subject token-set Jaccard at/above
 * {@link SUBJECT_SIMILARITY_THRESHOLD} (fuzzy dedup for heterogeneous phrasings).
 */
function isSameFinding(anchor: NormalizedFinding, candidate: NormalizedFinding): boolean {
  if (anchor.comment.file !== candidate.comment.file) return false;
  if (Math.abs(anchor.comment.line - candidate.comment.line) > MAX_LINE_DELTA) return false;
  if (anchor.subject === candidate.subject) return true;
  return jaccard(anchor.tokens, candidate.tokens) >= SUBJECT_SIMILARITY_THRESHOLD;
}

/** A finding plus its precomputed normalised subject and subject token set. */
interface NormalizedFinding extends AuthoredFinding {
  subject: string;
  tokens: Set<string>;
}

/**
 * True when `candidate` outranks `incumbent` for survivorship within a cluster:
 * higher severity wins, ties broken by higher confidence. Equal rank keeps the
 * incumbent — and because the input is pre-sorted by a stable key, that keeps the
 * whole operation order-independent.
 */
function outranks(candidate: NormalizedFinding, incumbent: NormalizedFinding): boolean {
  const candSev = SEVERITY_RANK[candidate.comment.severity];
  const incSev = SEVERITY_RANK[incumbent.comment.severity];
  if (candSev !== incSev) return candSev > incSev;
  return (
    CONFIDENCE_RANK[candidate.comment.confidence] > CONFIDENCE_RANK[incumbent.comment.confidence]
  );
}

/**
 * Stable ordering key for clustering. Sorting by it before clustering makes the
 * merge deterministic and independent of angle completion order: file, then
 * line, then severity (desc), then confidence (desc), then body. The first two
 * group co-located findings; the rest fix a canonical anchor per cluster.
 */
function compareForClustering(a: NormalizedFinding, b: NormalizedFinding): number {
  if (a.comment.file !== b.comment.file) return a.comment.file < b.comment.file ? -1 : 1;
  if (a.comment.line !== b.comment.line) return a.comment.line - b.comment.line;
  const sevDiff = SEVERITY_RANK[b.comment.severity] - SEVERITY_RANK[a.comment.severity];
  if (sevDiff !== 0) return sevDiff;
  const confDiff = CONFIDENCE_RANK[b.comment.confidence] - CONFIDENCE_RANK[a.comment.confidence];
  if (confDiff !== 0) return confDiff;
  if (a.comment.body !== b.comment.body) return a.comment.body < b.comment.body ? -1 : 1;
  return 0;
}

/**
 * Merge findings from multiple angle finders into a deduplicated set.
 *
 * Two findings are considered the same when they share a file, sit within a few
 * lines of each other, and have either an identical or sufficiently similar
 * normalised subject — so heterogeneous models that phrase the same defect
 * differently collapse to one finding. The higher-severity copy wins (ties
 * broken by higher confidence), carrying its own author model forward, so a
 * finding one angle rates CRITICAL is not masked by another angle's WARN.
 *
 * Deterministic by construction: inputs are sorted by a stable key before
 * clustering, so the same set of findings always yields the same merged output
 * regardless of the order angles complete in.
 */
export function triageFindings(groups: AuthoredFinding[][]): AuthoredFinding[] {
  const normalized: NormalizedFinding[] = [];
  for (const group of groups) {
    for (const finding of group) {
      const subject = normalizeSubject(finding.comment.body);
      normalized.push({ ...finding, subject, tokens: subjectTokens(subject) });
    }
  }
  normalized.sort(compareForClustering);

  const survivors: NormalizedFinding[] = [];
  for (const finding of normalized) {
    const clusterIndex = survivors.findIndex((survivor) => isSameFinding(survivor, finding));
    if (clusterIndex === -1) {
      survivors.push(finding);
      continue;
    }
    if (outranks(finding, survivors[clusterIndex])) {
      survivors[clusterIndex] = finding;
    }
  }

  return survivors.map(({ comment, authorModel }) => ({ comment, authorModel }));
}
