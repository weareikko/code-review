import { appendFingerprintMarkers, extractDiffHunkContext, fingerprints } from './fingerprints.js';
import type {
  Confidence,
  DiffRefs,
  GeneratedComment,
  GitLabDiscussionPayload,
  ReviewComment,
  Side,
} from './types.js';

declare const __PKG_VERSION__: string;

const CONVENTIONAL_TITLE_RE = /^[a-z]+(?:\s*\([^)]+\))?:\s.+$/;

function boldCommentTitle(body: string): string {
  const newlineIndex = body.indexOf('\n');
  const firstLine = newlineIndex === -1 ? body : body.slice(0, newlineIndex);
  if (!CONVENTIONAL_TITLE_RE.test(firstLine)) return body;
  const rest = newlineIndex === -1 ? '' : body.slice(newlineIndex);
  return `**${firstLine}**${rest}`;
}

/**
 * Builds the visible body of an inline comment.
 *
 * Layout:
 *   <bold Conventional Comment title>
 *   <discussion>
 *
 *   _Confidence: <level>._
 *
 *   ---
 *
 *   <commit footer>
 *
 * The confidence line sits between the reviewer's discussion and the
 * horizontal rule so developers can see the reviewer's certainty without
 * scrolling past the footer. The footer mirrors the format used in the
 * MR-level summary note.
 *
 * Neither the confidence line nor the footer is included in the fingerprint
 * hash, so comment identity (deduplication) remains stable across commits
 * even when the SHA in the footer changes or the reviewer revises its
 * confidence judgment.
 */
export function buildCommentBody(body: string, commitSha: string, confidence: Confidence): string {
  const confidenceLine = `_Confidence: ${confidence}._`;
  const footer = `<sub>Reviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) v${__PKG_VERSION__} for commit ${commitSha}.</sub>`;
  return `${boldCommentTitle(body.trim())}\n\n${confidenceLine}\n\n---\n\n${footer}`;
}

/** A diff line resolved to the GitLab position fields it requires. */
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
 * Classify a target line in a unified diff into the GitLab `text` position
 * fields it needs. GitLab requires:
 *   - an **added** line: `new_line` only,
 *   - a **removed** line: `old_line` only,
 *   - an **unchanged (context)** line: BOTH `old_line` and `new_line`.
 *
 * A context line with a one-sided position is accepted by the draft-notes API
 * but makes `bulk_publish` return 500 (GitLab skips position validation on
 * draft creation — gitlab-org/gitlab#579609). We feed the reviewer ±20 lines of
 * context, so it routinely anchors comments on unchanged lines; resolving them
 * two-sided here is what prevents the publish failure.
 *
 * Returns `null` when the line is not part of the diff for `file`, so the caller
 * can fall back rather than emit a position GitLab cannot place.
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

export function buildPayload(
  comment: ReviewComment,
  body: string,
  refs: DiffRefs,
  resolved?: ResolvedDiffLine | null,
): GitLabDiscussionPayload {
  // Prefer the diff-resolved sides (two-sided for context lines). Fall back to
  // the legacy one-sided position only when the line cannot be located in the
  // diff, so an unresolvable line behaves as before rather than being dropped.
  const lineFields = resolved
    ? {
        ...(resolved.oldLine !== undefined ? { old_line: resolved.oldLine } : {}),
        ...(resolved.newLine !== undefined ? { new_line: resolved.newLine } : {}),
      }
    : comment.side === 'LEFT'
      ? { old_line: comment.line }
      : { new_line: comment.line };
  return {
    body,
    position: {
      position_type: 'text',
      base_sha: refs.base_sha,
      start_sha: refs.start_sha,
      head_sha: refs.head_sha,
      old_path: comment.file,
      new_path: comment.file,
      ...lineFields,
    },
  };
}

export function buildGeneratedComments(
  comments: ReviewComment[],
  diff: string,
  refs: DiffRefs,
  existingFingerprints: Set<string>,
): GeneratedComment[] {
  const seen = new Set(existingFingerprints);

  return comments.map((comment) => {
    const hunk = extractDiffHunkContext(diff, comment.file, comment.line, comment.side);
    const fp = fingerprints(comment, hunk);
    const duplicate = seen.has(fp.primary) || seen.has(fp.secondary);
    seen.add(fp.primary);
    seen.add(fp.secondary);

    // Fingerprints are computed from comment.body (the raw reviewer output)
    // before the commit footer is appended, so deduplication is unaffected by
    // the SHA changing between review runs.
    const bodyWithFooter = buildCommentBody(comment.body, refs.head_sha, comment.confidence);
    const resolved = resolveDiffLine(diff, comment.file, comment.line, comment.side);

    return {
      comment,
      fingerprints: fp,
      duplicate,
      payload: buildPayload(comment, appendFingerprintMarkers(bodyWithFooter, fp), refs, resolved),
    };
  });
}
