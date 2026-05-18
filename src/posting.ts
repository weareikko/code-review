import type { DraftNote, GitLabClient } from './gitlab.js';
import type { Fingerprints, GeneratedComment } from './types.js';

import { extractExistingFingerprints } from './fingerprints.js';

export type PostingMode = 'direct' | 'draft';

export const POSTING_MODES: readonly PostingMode[] = ['direct', 'draft'];

export const DRAFT_CONCURRENCY = 10;

export interface PostResult {
  posted: number;
  drafts?: {
    abandoned: number;
    created: number;
    deletedPrePublish: number;
    published: number;
  };
}

export async function postGeneratedComments(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  generated: GeneratedComment[],
  mode: PostingMode = 'direct',
): Promise<PostResult> {
  const fresh = generated.filter((item) => !item.duplicate);
  if (mode === 'draft') return postViaDrafts(gitlab, project, mr, fresh);
  if (fresh.length === 0) return { posted: 0 };
  return postDirectly(gitlab, project, mr, fresh);
}

async function postDirectly(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  fresh: GeneratedComment[],
): Promise<PostResult> {
  let posted = 0;
  for (const item of fresh) {
    await gitlab.postDiscussion(project, mr, item.payload);
    posted += 1;
  }
  return { posted };
}

interface DraftRecord {
  id: number;
  fingerprints: Fingerprints;
}

async function postViaDrafts(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  fresh: GeneratedComment[],
): Promise<PostResult> {
  const abandoned = await cleanupOrphanDrafts(gitlab, project, mr);

  if (fresh.length === 0) {
    return {
      posted: 0,
      drafts: { abandoned, created: 0, deletedPrePublish: 0, published: 0 },
    };
  }

  const drafts = await createDraftsConcurrently(gitlab, project, mr, fresh);
  const deletedPrePublish = await deleteRaceLosers(gitlab, project, mr, drafts);

  await gitlab.bulkPublishDraftNotes(project, mr);

  const published = drafts.length - deletedPrePublish;
  return {
    posted: published,
    drafts: { abandoned, created: drafts.length, deletedPrePublish, published },
  };
}

async function cleanupOrphanDrafts(
  gitlab: GitLabClient,
  project: string,
  mr: string,
): Promise<number> {
  const me = await gitlab.getCurrentUser();
  const drafts = await gitlab.listDraftNotes(project, mr);
  const mine = drafts.filter((draft: DraftNote) => draft.author_id === me.id);
  if (mine.length === 0) return 0;
  await Promise.all(mine.map((draft) => gitlab.deleteDraftNote(project, mr, draft.id)));
  return mine.length;
}

async function createDraftsConcurrently(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  fresh: GeneratedComment[],
): Promise<DraftRecord[]> {
  const records: DraftRecord[] = Array.from({ length: fresh.length });
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= fresh.length) return;
      const item = fresh[index];
      const draft = await gitlab.createDraftNote(project, mr, item.payload);
      records[index] = { id: draft.id, fingerprints: item.fingerprints };
    }
  }

  const workerCount = Math.min(DRAFT_CONCURRENCY, fresh.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return records;
}

async function deleteRaceLosers(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  drafts: DraftRecord[],
): Promise<number> {
  const live = extractExistingFingerprints(await gitlab.getDiscussions(project, mr));
  const colliding = drafts.filter(
    (draft) => live.has(draft.fingerprints.primary) || live.has(draft.fingerprints.secondary),
  );
  if (colliding.length === 0) return 0;
  await Promise.all(colliding.map((draft) => gitlab.deleteDraftNote(project, mr, draft.id)));
  return colliding.length;
}
