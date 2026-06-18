import { jsonrepair } from 'jsonrepair';
import { FINGERPRINT_MARKER_PATTERN } from './fingerprints.js';
import { normalizeConfidence, normalizeSeverity, type ReviewComment, type Side } from './types.js';

/** Why the reviewer's JSON could not be recovered. Surfaced for diagnostics. */
export type ParseFailureReason =
  /** A ```json fence was present but its contents could not be parsed or repaired. */
  | 'fence_unparseable'
  /** An unfenced reviewer-shaped object was present but could not be parsed or repaired. */
  | 'object_unparseable';

export interface ParseFailure {
  reason: ParseFailureReason;
  /** Whitespace-collapsed first ~200 chars of the offending block, for logs/OTel. */
  preview: string;
}

export interface ParseResult {
  comments: ReviewComment[];
  summary: string | null;
  warnings: string[];
  /**
   * Set when the reviewer clearly intended to emit the `{ summary, comments }`
   * JSON object but it could not be parsed (even after a best-effort repair),
   * and nothing usable was recovered; `null` otherwise. The CLI fails loudly on
   * a non-null value rather than marking the job successful with an empty review.
   */
  malformed: ParseFailure | null;
}

/**
 * Anchors a reviewer JSON object on its first key (`{"summary"` / `{"comments"`).
 * Anchoring on the key — rather than scanning from every `{` — skips braces in
 * prose and in code spans (e.g. `` `{ entries }` ``) that would otherwise be
 * mistaken for the start of the object. Global so all anchors can be scanned.
 */
const REVIEWER_OBJECT_ANCHOR_RE = /\{\s*"(?:summary|comments)"\s*:/g;

/** Collapse whitespace and clip to a short, log-friendly preview. */
function toPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

const HEADER_RE = /^\s*(?<file>.+):(?<line>\d+)\s+\((?<side>LEFT|RIGHT)\)\s*$/u;
const GITHUB_STYLE_HEADER_RE =
  /^\s*(?:\*\*)?`?(?<file>.+):(?<line>\d+)`?(?:\*\*)?\s*(?:[·-]|\()\s*(?<side>LEFT|RIGHT)\)?\s*$/u;
const FINGERPRINT_MARKER_RE = new RegExp(FINGERPRINT_MARKER_PATTERN, 'gi');
const JSON_COMMENT_MARKER_RE = /<!--\s*gitlab-review-comment\s*([\s\S]*?)-->/gi;
const JSON_FENCE_RE = /^```json[^\S\r\n]*(?:\r?\n)([\s\S]*?)^```[^\S\r\n]*$/gim;
const INLINE_SECTION_HEADER_RE = /^==\s*Inline Comments\s*==\s*$/im;
const SECTION_BREAK_RE = /^==\s*[^=].*==\s*$/;

function normalizeSide(value: unknown): Side {
  return String(value ?? '').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
}

function addJsonComment(out: ReviewComment[], item: unknown): void {
  if (!item || typeof item !== 'object') return;
  const value = item as Record<string, unknown>;
  const file = value.file ?? value.path ?? value.new_path ?? value.old_path;
  const rawLine = value.line ?? value.new_line ?? value.old_line;
  const line = Number(rawLine);
  const body = String(value.body ?? value.comment ?? value.message ?? '')
    .replace(FINGERPRINT_MARKER_RE, '')
    .trim();
  const side = normalizeSide(value.side ?? (value.old_line ? 'LEFT' : 'RIGHT'));
  if (
    typeof file === 'string' &&
    file.length > 0 &&
    Number.isInteger(line) &&
    line > 0 &&
    body.length > 0
  ) {
    out.push({
      file,
      line,
      side,
      severity: normalizeSeverity(value.severity),
      confidence: normalizeConfidence(value.confidence),
      body,
    });
  }
}

function normalizeSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isReviewerShaped(parsed: unknown): parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const value = parsed as Record<string, unknown>;
  return 'summary' in value || 'comments' in value;
}

/**
 * Pull comments and the summary out of a parsed reviewer value into `out`.
 * Accepts a `{ summary?, comments? }` object or a bare array of comments.
 * Returns `contributed: false` for anything else (e.g. an unrelated JSON object)
 * so callers can tell a real reviewer payload apart from incidental JSON.
 */
function absorbReviewerValue(
  value: unknown,
  out: ReviewComment[],
): { contributed: boolean; summary: string | null } {
  if (Array.isArray(value)) {
    for (const item of value) addJsonComment(out, item);
    return { contributed: true, summary: null };
  }
  if (isReviewerShaped(value)) {
    const list = Array.isArray(value.comments) ? value.comments : [];
    for (const item of list) addJsonComment(out, item);
    return { contributed: true, summary: normalizeSummary(value.summary) };
  }
  return { contributed: false, summary: null };
}

/**
 * Return the index of the `}` that balances the `{` at `start`, or -1 if the
 * braces never balance. Skips over string literals so braces inside JSON string
 * values do not break the balance count.
 */
function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Locate a reviewer-shaped JSON object embedded anywhere in `markdown` (bare, or
 * surrounded by prose). Candidates are anchored on the reviewer key
 * (`{"summary"` / `{"comments"`) so braces in prose and code spans are skipped,
 * then balanced and run through the strict-then-repair parser — so a lightly
 * malformed unfenced object is recovered rather than dropped. Never throws.
 */
function extractReviewerJsonObject(markdown: string): JsonParseOutcome | null {
  // Fast path: anchor on the reviewer key so braces in prose and code spans are
  // skipped outright.
  REVIEWER_OBJECT_ANCHOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REVIEWER_OBJECT_ANCHOR_RE.exec(markdown)) !== null) {
    const outcome = tryReviewerObjectAt(markdown, match.index);
    if (outcome) return outcome;
    // Not parseable/reviewer-shaped from this anchor; try the next one.
  }
  // Fallback: scan from every `{` so a reviewer object whose first key is not
  // `summary`/`comments` (rare, but valid) is recovered rather than dropped.
  // Non-reviewer-shaped candidates (prose, code spans) fail the shape check and
  // are skipped, exactly as the anchored pass would have.
  for (let start = markdown.indexOf('{'); start !== -1; start = markdown.indexOf('{', start + 1)) {
    const outcome = tryReviewerObjectAt(markdown, start);
    if (outcome) return outcome;
  }
  return null;
}

/** Balance, parse (with repair), and shape-check a candidate object at `start`. */
function tryReviewerObjectAt(markdown: string, start: number): JsonParseOutcome | null {
  const end = findBalancedEnd(markdown, start);
  if (end === -1) return null;
  const outcome = tryParseJson(markdown.slice(start, end + 1));
  return outcome && isReviewerShaped(outcome.value) ? outcome : null;
}

interface JsonParseOutcome {
  value: unknown;
  /** True when strict `JSON.parse` failed and the value came from a repair pass. */
  repaired: boolean;
}

/**
 * Parse `text` as JSON, falling back to a best-effort repair pass that fixes
 * the common LLM serialization defects (trailing commas, lightly mis-escaped
 * quotes/newlines in string values). Returns null when neither strict parsing
 * nor repair yields valid JSON. Never throws.
 */
function tryParseJson(text: string): JsonParseOutcome | null {
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch {
    // Strict parsing failed; attempt a best-effort repair below.
  }
  try {
    return { value: JSON.parse(jsonrepair(text)), repaired: true };
  } catch {
    return null;
  }
}

function parseJsonComments(
  markdown: string,
  out: ReviewComment[],
  warnings: string[],
): { summary: string | null; malformed: ParseFailure | null } {
  let summary: string | null = null;
  let recoveredReviewerJson = false;
  let fenceFailurePreview: string | null = null;
  let usedRepair = false;
  for (const match of markdown.matchAll(JSON_FENCE_RE)) {
    const fenceBody = match[1] ?? '';
    // An empty/whitespace fence carries nothing to parse — not a failure.
    if (fenceBody.trim().length === 0) continue;
    const outcome = tryParseJson(fenceBody);
    if (!outcome) {
      if (fenceFailurePreview === null) fenceFailurePreview = toPreview(fenceBody);
      continue;
    }
    const result = absorbReviewerValue(outcome.value, out);
    // A fence that parses to unrelated (non-reviewer-shaped) JSON must neither
    // count as a recovered review nor mask a malformed reviewer object below.
    if (!result.contributed) continue;
    recoveredReviewerJson = true;
    if (outcome.repaired) usedRepair = true;
    if (summary === null) summary = result.summary;
  }

  // Fallback: only when no reviewer-shaped fenced JSON was recovered, accept an
  // unfenced top-level reviewer object (bare, or appended after prose) so
  // unfenced model output is not silently dropped.
  let recoveredBare = false;
  if (!recoveredReviewerJson) {
    const outcome = extractReviewerJsonObject(markdown);
    if (outcome) {
      recoveredBare = true;
      if (outcome.repaired) usedRepair = true;
      const result = absorbReviewerValue(outcome.value, out);
      if (summary === null) summary = result.summary;
    }
  }

  for (const match of markdown.matchAll(JSON_COMMENT_MARKER_RE)) {
    const outcome = tryParseJson(match[1] ?? '');
    if (outcome) addJsonComment(out, outcome.value);
  }

  if (usedRepair) {
    warnings.push('Recovered a malformed reviewer JSON block via best-effort repair.');
  }

  // The reviewer clearly attempted a JSON object but nothing usable came out of
  // it — either a ```json fence failed to parse, or an unfenced reviewer object
  // is present yet unparseable. Report the failure (with a reason + preview) so
  // the CLI can fail rather than post an empty review.
  const recovered = recoveredReviewerJson || recoveredBare;
  return { summary, malformed: recovered ? null : detectFailure(markdown, fenceFailurePreview) };
}

/**
 * Classify why nothing was recovered. A failed ```json fence takes priority
 * (the model emitted a fenced object); otherwise look for an unfenced
 * reviewer-shaped anchor. Returns null when there was no JSON attempt at all
 * (a legitimately empty/prose-only review).
 */
function detectFailure(markdown: string, fenceFailurePreview: string | null): ParseFailure | null {
  if (fenceFailurePreview !== null) {
    return { reason: 'fence_unparseable', preview: fenceFailurePreview };
  }
  REVIEWER_OBJECT_ANCHOR_RE.lastIndex = 0;
  const anchor = REVIEWER_OBJECT_ANCHOR_RE.exec(markdown);
  if (anchor) {
    // Clip the preview to the balanced object when possible so it points at the
    // offending JSON rather than spilling into unrelated trailing prose.
    const end = findBalancedEnd(markdown, anchor.index);
    const slice = markdown.slice(anchor.index, end === -1 ? undefined : end + 1);
    return { reason: 'object_unparseable', preview: toPreview(slice) };
  }
  return null;
}

function matchHeader(line: string): { file: string; line: number; side: Side } | null {
  const match = line.match(HEADER_RE) ?? line.match(GITHUB_STYLE_HEADER_RE);
  if (!match?.groups) return null;
  const number = Number(match.groups.line);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    file: match.groups.file.trim().replace(/^`|`$/g, ''),
    line: number,
    side: match.groups.side as Side,
  };
}

function parseInlineSection(markdown: string, out: ReviewComment[], warnings: string[]): void {
  const marker = markdown.search(INLINE_SECTION_HEADER_RE);
  if (marker === -1) return;

  const section = markdown.slice(marker).split(/\r?\n/).slice(1);
  let current: {
    file: string;
    line: number;
    side: Side;
    body: string[];
  } | null = null;
  let sawBodyBeforeHeader = false;

  const flush = (): void => {
    if (!current) return;
    const body = current.body.join('\n').replace(FINGERPRINT_MARKER_RE, '').trim();
    if (body.length > 0) {
      // Markdown inline comments carry no severity or confidence signal —
      // default to the lowest severity and high confidence.
      out.push({
        file: current.file,
        line: current.line,
        side: current.side,
        severity: 'info',
        confidence: 'high',
        body,
      });
    }
    current = null;
  };

  for (const rawLine of section) {
    if (SECTION_BREAK_RE.test(rawLine)) break;
    const header = matchHeader(rawLine);
    if (header) {
      flush();
      current = { ...header, body: [] };
      continue;
    }
    if (current) {
      current.body.push(rawLine);
    } else if (rawLine.trim().length > 0) {
      sawBodyBeforeHeader = true;
    }
  }
  flush();

  if (sawBodyBeforeHeader) {
    warnings.push(
      'Ignored text in the inline comments section before the first parseable comment header.',
    );
  }
}

export function parseReviewMarkdownWithWarnings(markdown: string): ParseResult {
  const comments: ReviewComment[] = [];
  const warnings: string[] = [];
  const { summary, malformed } = parseJsonComments(markdown, comments, warnings);
  parseInlineSection(markdown, comments, warnings);

  // A JSON block was unparseable, but other sections (legacy `== Inline
  // Comments ==` markdown or `<!-- gitlab-review-comment -->` markers) still
  // yielded a usable review. Keep it and downgrade the failure to a warning
  // rather than discarding a good review — backwards-compatibility with the
  // legacy reviewer formats takes priority over the strict JSON path.
  if (malformed && comments.length > 0) {
    warnings.push(
      `A reviewer JSON block was unparseable (${malformed.reason}), but ${comments.length} comment(s) were recovered from other sections; continuing.`,
    );
    return { comments, summary, warnings, malformed: null };
  }

  return { comments, summary, warnings, malformed };
}

export function parseReviewMarkdown(markdown: string): ReviewComment[] {
  return parseReviewMarkdownWithWarnings(markdown).comments;
}
