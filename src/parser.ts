import { jsonrepair } from 'jsonrepair';
import { FINGERPRINT_MARKER_PATTERN } from './fingerprints.js';
import { normalizeConfidence, normalizeSeverity, type ReviewComment, type Side } from './types.js';

export interface ParseResult {
  comments: ReviewComment[];
  summary: string | null;
  warnings: string[];
  /**
   * True when the reviewer clearly intended to emit the `{ summary, comments }`
   * JSON object but it could not be parsed (even after a best-effort repair),
   * and nothing usable was recovered. The CLI fails loudly on this rather than
   * marking the job successful with an empty review.
   */
  malformed: boolean;
}

/** Detects an attempted reviewer JSON object (`{ ... "summary"/"comments": }`). */
const REVIEWER_OBJECT_RE = /(?:^|[\r\n])\s*\{[\s\S]{0,80}?"(?:summary|comments)"\s*:/;

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
 * Locate the first top-level, reviewer-shaped JSON object embedded anywhere in
 * `markdown` (bare, or surrounded by prose). Walks the string with a
 * brace-matching scanner that skips over string literals so braces inside JSON
 * string values do not break the balance count. Each candidate is run through
 * the strict-then-repair parser, so a lightly malformed unfenced object is
 * recovered rather than dropped. Never throws on bad input.
 */
function extractFirstJsonObject(markdown: string): JsonParseOutcome | null {
  for (let start = markdown.indexOf('{'); start !== -1; start = markdown.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < markdown.length; i += 1) {
      const char = markdown[i];
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
        if (depth === 0) {
          const candidate = markdown.slice(start, i + 1);
          const outcome = tryParseJson(candidate);
          if (outcome && isReviewerShaped(outcome.value)) return outcome;
          // Not reviewer-shaped (even after repair); keep scanning from next '{'.
          break;
        }
      }
    }
  }
  return null;
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
): { summary: string | null; malformed: boolean } {
  let summary: string | null = null;
  let parsedFencedJson = false;
  let fenceFailed = false;
  let usedRepair = false;
  for (const match of markdown.matchAll(JSON_FENCE_RE)) {
    const outcome = tryParseJson(match[1] ?? '');
    if (!outcome) {
      fenceFailed = true;
      continue;
    }
    const parsed = outcome.value;
    if (parsed && typeof parsed === 'object') parsedFencedJson = true;
    if (outcome.repaired) usedRepair = true;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown> | null)?.comments)
        ? (parsed as { comments: unknown[] }).comments
        : [];
    for (const item of list) addJsonComment(out, item);
    if (summary === null && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      summary = normalizeSummary((parsed as Record<string, unknown>).summary);
    }
  }

  // Fallback: only when no fenced JSON parsed, accept an unfenced top-level
  // reviewer object (bare, or appended after prose) so unfenced model output
  // is not silently dropped.
  let recoveredBare = false;
  if (!parsedFencedJson) {
    const outcome = extractFirstJsonObject(markdown);
    if (outcome) {
      recoveredBare = true;
      if (outcome.repaired) usedRepair = true;
      const parsed = outcome.value as Record<string, unknown>;
      const list = Array.isArray(parsed.comments) ? parsed.comments : [];
      for (const item of list) addJsonComment(out, item);
      if (summary === null) summary = normalizeSummary(parsed.summary);
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
  // is present yet unparseable. Flag it so the CLI can fail rather than post an
  // empty review.
  const recovered = parsedFencedJson || recoveredBare;
  const attemptedJson = fenceFailed || REVIEWER_OBJECT_RE.test(markdown);
  const malformed = attemptedJson && !recovered;
  return { summary, malformed };
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

  return { comments, summary, warnings, malformed };
}

export function parseReviewMarkdown(markdown: string): ReviewComment[] {
  return parseReviewMarkdownWithWarnings(markdown).comments;
}
