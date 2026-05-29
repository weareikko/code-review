import { appendFingerprintMarkers, extractDiffHunkContext, fingerprints } from './fingerprints.js';
import type {
  DiffRefs,
  GeneratedComment,
  GitLabDiscussionPayload,
  ReviewComment,
} from './types.js';

const CONVENTIONAL_TITLE_RE = /^[a-z]+(?:\s*\([^)]+\))?:\s.+$/;

function boldCommentTitle(body: string): string {
  const newlineIndex = body.indexOf('\n');
  const firstLine = newlineIndex === -1 ? body : body.slice(0, newlineIndex);
  if (!CONVENTIONAL_TITLE_RE.test(firstLine)) return body;
  const rest = newlineIndex === -1 ? '' : body.slice(newlineIndex);
  return `**${firstLine}**${rest}`;
}

/**
 * Builds the visible body of an inline comment by appending a commit footer
 * after a horizontal rule. The footer mirrors the format used in the MR-level
 * summary note so developers can tell at a glance which commit triggered the
 * comment and whether it belongs to an earlier review pass.
 *
 * The footer is appended to the payload body only — it is NOT included in the
 * fingerprint hash, so comment identity (deduplication) remains stable across
 * commits even when the SHA in the footer changes.
 */
export function buildCommentBody(body: string, commitSha: string): string {
  const footer = `<sub>Reviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) for commit ${commitSha}.</sub>`;
  return `${boldCommentTitle(body.trim())}\n\n---\n\n${footer}`;
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
    const bodyWithFooter = buildCommentBody(comment.body, refs.head_sha);

    return {
      comment,
      fingerprints: fp,
      duplicate,
      payload: buildPayload(comment, appendFingerprintMarkers(bodyWithFooter, fp), refs),
    };
  });
}
