import { createHash } from 'node:crypto';
import type { Discussion } from './gitlab.js';
import type { Fingerprints, ReviewComment, Side } from './types.js';

/**
 * Pattern source for the hidden fingerprint marker, capturing the hash group.
 * Shared with the parser and prior-thread detection so the marker format is
 * defined in one place; each call site builds its own RegExp with the flags it
 * needs (the capture group is harmless when only stripping or testing). This is
 * a stable wire contract — see CLAUDE.md before changing it.
 *
 * Reads match BOTH the current `code-review:` prefix and the legacy
 * `gitlab-review:` prefix so findings posted under the old product identity are
 * still recognised and deduplicated after the rename. Writes emit the current
 * prefix (see {@link appendFingerprintMarkers}).
 */
export const FINGERPRINT_MARKER_PATTERN = String.raw`<!--\s*(?:code-review|gitlab-review):fingerprint-(?:primary|secondary):([a-f0-9]+)\s*-->`;

const FINGERPRINT_MARKER_RE = new RegExp(FINGERPRINT_MARKER_PATTERN, 'gi');

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function normalizeBody(body: string): string {
  return body.replace(FINGERPRINT_MARKER_RE, '').replace(/\s+/g, ' ').trim();
}

interface FileState {
  oldPath: string;
  newPath: string;
}

function matchesFile(state: FileState, file: string): boolean {
  return state.oldPath === file || state.newPath === file;
}

function parseHunkHeader(line: string): { oldLine: number; newLine: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

function hunkContainsLine(
  hunkLines: string[],
  targetLine: number,
  side: Side,
  startOld: number,
  startNew: number,
): boolean {
  let oldLine = startOld;
  let newLine = startNew;

  for (const text of hunkLines.slice(1)) {
    const prefix = text[0] ?? ' ';
    if (side === 'RIGHT' && prefix !== '-' && newLine === targetLine) return true;
    if (side === 'LEFT' && prefix !== '+' && oldLine === targetLine) return true;
    if (prefix !== '+') oldLine += 1;
    if (prefix !== '-') newLine += 1;
  }

  return false;
}

export function extractDiffHunkContext(
  diff: string,
  file: string,
  line: number,
  side: Side,
): string {
  const lines = diff.split('\n');
  const state: FileState = { oldPath: '', newPath: '' };

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text.startsWith('diff --git ')) {
      state.oldPath = '';
      state.newPath = '';
      continue;
    }

    const oldMatch = text.match(/^--- (?:a\/(.*)|\/dev\/null)$/);
    if (oldMatch) state.oldPath = oldMatch[1] ?? '/dev/null';
    const newMatch = text.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/);
    if (newMatch) state.newPath = newMatch[1] ?? '/dev/null';

    if (!text.startsWith('@@') || !matchesFile(state, file)) continue;
    const header = parseHunkHeader(text);
    if (!header) continue;

    let end = i + 1;
    while (
      end < lines.length &&
      !lines[end].startsWith('@@') &&
      !lines[end].startsWith('diff --git ')
    ) {
      end += 1;
    }

    const hunkLines = lines.slice(i, end);
    if (hunkContainsLine(hunkLines, line, side, header.oldLine, header.newLine)) {
      return hunkLines.join('\n');
    }
  }

  return `${file}:${side}:${line}`;
}

export function fingerprints(comment: ReviewComment, hunkContext: string): Fingerprints {
  const bodyHash = sha256(normalizeBody(comment.body));
  const hunkHash = sha256(hunkContext);
  return {
    // Primary: exact match — same file/side/line, same body, same surrounding
    // hunk. It shifts when the author edits the hunk, which is why the secondary
    // exists as the edit-stable fallback.
    primary: sha256([comment.file, comment.side, comment.line, bodyHash, hunkHash].join('|')),
    // Secondary: edit-stable. Deliberately excludes both the line number and the
    // hunk context, so the same finding on the same file/side stays deduplicated
    // when the author edits nearby lines (which grow/shift the hunk). Folding the
    // hunk in here defeated that fallback and re-posted findings on every nearby
    // edit (#91).
    secondary: sha256([comment.file, comment.side, bodyHash].join('|')),
  };
}

export function appendFingerprintMarkers(body: string, fp: Fingerprints): string {
  return `${body.trim()}\n\n<!-- code-review:fingerprint-primary:${fp.primary} -->\n<!-- code-review:fingerprint-secondary:${fp.secondary} -->`;
}

export function extractExistingFingerprints(discussions: Discussion[]): Set<string> {
  const set = new Set<string>();
  for (const discussion of discussions) {
    for (const note of discussion.notes ?? []) {
      for (const match of String(note.body ?? '').matchAll(FINGERPRINT_MARKER_RE)) {
        set.add(match[1]);
      }
    }
  }
  return set;
}
