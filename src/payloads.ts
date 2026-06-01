import { appendFingerprintMarkers, extractDiffHunkContext, fingerprints } from './fingerprints.js';
import type {
  Confidence,
  DiffRefs,
  GeneratedComment,
  GitLabDiscussionPayload,
  ReviewComment,
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

export function buildPayload(
  comment: ReviewComment,
  body: string,
  refs: DiffRefs,
): GitLabDiscussionPayload {
  return {
    body,
    position: {
      position_type: 'text',
      base_sha: refs.base_sha,
      start_sha: refs.start_sha,
      head_sha: refs.head_sha,
      old_path: comment.file,
      new_path: comment.file,
      ...(comment.side === 'LEFT' ? { old_line: comment.line } : { new_line: comment.line }),
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

    return {
      comment,
      fingerprints: fp,
      duplicate,
      payload: buildPayload(comment, appendFingerprintMarkers(bodyWithFooter, fp), refs),
    };
  });
}
