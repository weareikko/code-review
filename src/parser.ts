import { normalizeSeverity, type ReviewComment, type Severity, type Side } from './types.js';

export interface ParseResult {
  comments: ReviewComment[];
  summary: string | null;
  warnings: string[];
}

const HEADER_RE = /^\s*(?<emoji>[🔴🟡🔵])?\s*(?<file>.+):(\d+)\s+\((?<side>LEFT|RIGHT)\)\s*$/u;
const GITHUB_STYLE_HEADER_RE =
  /^\s*(?<emoji>[🔴🟡🔵])?\s*(?:\*\*)?`?(?<file>.+):(\d+)`?(?:\*\*)?\s*(?:[·-]|\()\s*(?<side>LEFT|RIGHT)\)?\s*$/u;
const LEGACY_PROJECT_MARKER = ['pi', 'reviewer'].join('-');
const PROJECT_MARKER_RE = String.raw`(?:gitlab-review|${LEGACY_PROJECT_MARKER})`;
const FINGERPRINT_MARKER_RE = new RegExp(
  String.raw`<!--\s*${PROJECT_MARKER_RE}:fingerprint-(?:primary|secondary):[a-f0-9]+\s*-->`,
  'gi',
);
const JSON_COMMENT_MARKER_RE = new RegExp(
  String.raw`<!--\s*(?:gitlab-review|${LEGACY_PROJECT_MARKER})-comment\s*([\s\S]*?)-->`,
  'gi',
);

function severityFromEmoji(emoji: string | undefined): Severity {
  if (emoji === '🔴') return 'critical';
  if (emoji === '🟡') return 'warn';
  return 'info';
}

function inferSeverity(body: string, fallback: Severity): Severity {
  const first = body.trimStart()[0];
  if (first === '🔴' || first === '🟡' || first === '🔵') return normalizeSeverity(first);
  return fallback;
}

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
    out.push({ file, line, side, severity: normalizeSeverity(value.severity), body });
  }
}

function normalizeSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseJsonComments(markdown: string, out: ReviewComment[]): string | null {
  let summary: string | null = null;
  const fence = /^```json[^\S\r\n]*(?:\r?\n)([\s\S]*?)^```[^\S\r\n]*$/gim;
  for (const match of markdown.matchAll(fence)) {
    try {
      const parsed = JSON.parse(match[1] ?? '');
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

  for (const match of markdown.matchAll(JSON_COMMENT_MARKER_RE)) {
    try {
      addJsonComment(out, JSON.parse(match[1] ?? ''));
    } catch {
      // Ignore malformed legacy comment markers.
    }
  }

  return summary;
}

function matchHeader(
  line: string,
): { file: string; line: number; side: Side; severity: Severity } | null {
  const match = line.match(HEADER_RE) ?? line.match(GITHUB_STYLE_HEADER_RE);
  if (!match?.groups) return null;
  const rawLine = match[3];
  const number = Number(rawLine);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    file: match.groups.file.trim().replace(/^`|`$/g, ''),
    line: number,
    side: match.groups.side as Side,
    severity: severityFromEmoji(match.groups.emoji),
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
    severity: Severity;
    body: string[];
  } | null = null;
  let sawBodyBeforeHeader = false;

  const flush = (): void => {
    if (!current) return;
    const body = current.body.join('\n').replace(FINGERPRINT_MARKER_RE, '').trim();
    if (body.length > 0) {
      out.push({
        file: current.file,
        line: current.line,
        side: current.side,
        severity: inferSeverity(body, current.severity),
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
