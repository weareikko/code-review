import type {
  DiffRefs,
  GeneratedComment,
  GitLabDiscussionPayload,
  ReviewComment,
} from './types.js';

import { appendFingerprintMarkers, extractDiffHunkContext, fingerprints } from './fingerprints.js';

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

    return {
      comment,
      fingerprints: fp,
      duplicate,
      payload: buildPayload(comment, appendFingerprintMarkers(comment.body, fp), refs),
    };
  });
}
