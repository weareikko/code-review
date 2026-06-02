import { createHash } from 'node:crypto';
import type { Discussion } from './gitlab.js';
import type { Fingerprints, ReviewComment, Side } from './types.js';

const FINGERPRINT_MARKER_RE =
  /<!--\s*gitlab-review:fingerprint-(?:primary|secondary):([a-f0-9]+)\s*-->/gi;
const STRIP_FINGERPRINT_MARKER_RE =
  /<!--\s*gitlab-review:fingerprint-(?:primary|secondary):[a-f0-9]+\s*-->/gi;

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function normalizeBody(body: string): string {
  return body.replace(STRIP_FINGERPRINT_MARKER_RE, '').replace(/\s+/g, ' ').trim();
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
    primary: sha256([comment.file, comment.side, comment.line, bodyHash, hunkHash].join('|')),
    secondary: sha256([comment.file, comment.side, bodyHash, hunkHash].join('|')),
  };
}

export function appendFingerprintMarkers(body: string, fp: Fingerprints): string {
  return `${body.trim()}\n\n<!-- gitlab-review:fingerprint-primary:${fp.primary} -->\n<!-- gitlab-review:fingerprint-secondary:${fp.secondary} -->`;
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
