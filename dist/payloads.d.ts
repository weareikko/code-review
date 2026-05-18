import type { DiffRefs, GeneratedComment, GitLabDiscussionPayload, ReviewComment } from './types.js';
export declare function buildPayload(comment: ReviewComment, body: string, refs: DiffRefs): GitLabDiscussionPayload;
export declare function buildGeneratedComments(comments: ReviewComment[], diff: string, refs: DiffRefs, existingFingerprints: Set<string>): GeneratedComment[];
