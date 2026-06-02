import { FINGERPRINT_MARKER_PATTERN } from './fingerprints.js';
import { normalizeConfidence, normalizeSeverity, type ReviewComment, type Side } from './types.js';

export interface ParseResult {
  comments: ReviewComment[];
  summary: string | null;
  warnings: string[];
}

const HEADER_RE = /^\s*(?<file>.+):(?<line>\d+)\s+\((?<side>LEFT|RIGHT)\)\s*$/u;
const GITHUB_STYLE_HEADER_RE =
  /^\s*(?:\*\*)?`?(?<file>.+):(?<line>\d+)`?(?:\*\*)?\s*(?:[·-]|\()\s*(?<side>LEFT|RIGHT)\)?\s*$/u;
const FINGERPRINT_MARKER_RE = new RegExp(FINGERPRINT_MARKER_PATTERN, 'gi');
const JSON_COMMENT_MARKER_RE = /<!--\s*gitlab-review-comment\s*([\s\S]*?)-->/gi;

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
 * string values do not break the balance count. Never throws on bad input.
 */
function extractFirstJsonObject(markdown: string): Record<string, unknown> | null {
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
          try {
            const parsed: unknown = JSON.parse(candidate);
            if (isReviewerShaped(parsed)) return parsed;
          } catch {
            // Not valid JSON or not reviewer-shaped; keep scanning from the next '{'.
          }
          break;
        }
      }
    }
  }
  return null;
}

function parseJsonComments(markdown: string, out: ReviewComment[]): string | null {
  let summary: string | null = null;
  let parsedFencedJson = false;
  const fence = /^```json[^\S\r\n]*(?:\r?\n)([\s\S]*?)^```[^\S\r\n]*$/gim;
  for (const match of markdown.matchAll(fence)) {
    try {
      const parsed = JSON.parse(match[1] ?? '');
      if (parsed && typeof parsed === 'object') parsedFencedJson = true;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.comments)
          ? parsed.comments
          : [];
      for (const item of list) addJsonComment(out, item);
      if (summary === null && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        summary = normalizeSummary((parsed as Record<string, unknown>).summary);
      }
    } catch {
      // Ignore unrelated JSON fences; terminal parsing below will still run.
    }
  }

  // Fallback: only when no fenced JSON parsed, accept an unfenced top-level
  // reviewer object (bare, or appended after prose) so unfenced model output
  // is not silently dropped.
  if (!parsedFencedJson) {
    const parsed = extractFirstJsonObject(markdown);
    if (parsed) {
      const list = Array.isArray(parsed.comments) ? parsed.comments : [];
      for (const item of list) addJsonComment(out, item);
      if (summary === null) summary = normalizeSummary(parsed.summary);
    }
  }

  for (const match of markdown.matchAll(JSON_COMMENT_MARKER_RE)) {
    try {
      addJsonComment(out, JSON.parse(match[1] ?? ''));
    } catch {
      // Ignore malformed legacy comment markers.
    }
  }

  return summary;
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
  const marker = markdown.search(/^==\s*Inline Comments\s*==\s*$/im);
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
    if (/^==\s*[^=].*==\s*$/.test(rawLine)) break;
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
  const summary = parseJsonComments(markdown, comments);
  parseInlineSection(markdown, comments, warnings);

  return { comments, summary, warnings };
}

export function parseReviewMarkdown(markdown: string): ReviewComment[] {
  return parseReviewMarkdownWithWarnings(markdown).comments;
}
