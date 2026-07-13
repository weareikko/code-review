import type { Side } from './types.js';

/**
 * A diff line resolved to the old/new line numbers it maps to. GitLab consumes
 * both (`old_line`/`new_line`); GitHub consumes one plus a `side`. Shared by both
 * platforms so line resolution lives in one place.
 */
export interface ResolvedDiffLine {
  newLine?: number;
  oldLine?: number;
}

/**
 * Normalizes the path captured from a `---`/`+++` diff header. git tab-
 * terminates the path when the filename contains a space (and may append a
 * timestamp after the tab), so the captured group can be `my file.ts\t` or
 * `file.ts\t2026-...`. Cut at the first tab to recover the bare path. The
 * `/dev/null` sentinel (added/deleted file) arrives as `undefined` from the
 * regex alternation.
 */
function stripDiffPathSuffix(captured: string | undefined): string {
  return captured?.split('\t')[0] ?? '/dev/null';
}

function parseHunkHeader(line: string): { oldLine: number; newLine: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

/**
 * Classify a target line in a unified diff into the old/new line numbers it maps
 * to, tracking which side(s) apply:
 *   - an **added** line resolves to `newLine` only,
 *   - a **removed** line resolves to `oldLine` only,
 *   - an **unchanged (context)** line resolves to BOTH `oldLine` and `newLine`.
 *
 * GitLab needs both sides for context lines: a one-sided position is accepted by
 * the draft-notes API but makes `bulk_publish` return 500 (GitLab skips position
 * validation on draft creation — gitlab-org/gitlab#579609). GitHub uses a single
 * `line` + `side`, taking `newLine`/`RIGHT` or `oldLine`/`LEFT`. We feed the
 * reviewer ±20 lines of context, so it routinely anchors comments on unchanged
 * lines; resolving them here is what lets both platforms place the comment.
 *
 * Returns `null` when the line is not part of the diff for `file`, so the caller
 * can fall back (GitLab) or drop the comment (GitHub avoids a 422 on off-diff
 * lines) rather than emit a position the platform cannot place.
 */
export function resolveDiffLine(
  diff: string,
  file: string,
  target: number,
  side: Side,
): ResolvedDiffLine | null {
  const lines = diff.split('\n');
  let oldPath = '';
  let newPath = '';

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text.startsWith('diff --git ')) {
      oldPath = '';
      newPath = '';
      continue;
    }
    const oldMatch = text.match(/^--- (?:a\/(.*)|\/dev\/null)$/);
    if (oldMatch) oldPath = stripDiffPathSuffix(oldMatch[1]);
    const newMatch = text.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/);
    if (newMatch) newPath = stripDiffPathSuffix(newMatch[1]);

    if (!text.startsWith('@@') || (oldPath !== file && newPath !== file)) continue;
    const header = parseHunkHeader(text);
    if (!header) continue;

    let oldLine = header.oldLine;
    let newLine = header.newLine;
    for (let j = i + 1; j < lines.length; j += 1) {
      const body = lines[j];
      if (body.startsWith('@@') || body.startsWith('diff --git ')) break;
      const prefix = body[0] ?? ' ';
      if (side === 'RIGHT' && prefix !== '-' && newLine === target) {
        // Added line → new_line only; context line → both sides.
        return prefix === '+' ? { newLine } : { newLine, oldLine };
      }
      if (side === 'LEFT' && prefix !== '+' && oldLine === target) {
        // Removed line → old_line only; context line → both sides.
        return prefix === '-' ? { oldLine } : { oldLine, newLine };
      }
      if (prefix !== '+') oldLine += 1;
      if (prefix !== '-') newLine += 1;
    }
  }

  return null;
}
