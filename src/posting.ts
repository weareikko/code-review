import type { GitLabClient } from './gitlab.js';
import type { GeneratedComment } from './types.js';

export type PostingMode = 'direct' | 'draft';

export const POSTING_MODES: readonly PostingMode[] = ['direct', 'draft'];

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
  if (fresh.length === 0) return { posted: 0 };

  if (mode === 'draft') return postViaDrafts(gitlab, project, mr, fresh);
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

async function postViaDrafts(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  fresh: GeneratedComment[],
): Promise<PostResult> {
  const created: number[] = [];
  for (const item of fresh) {
    const draft = await gitlab.createDraftNote(project, mr, item.payload);
    created.push(draft.id);
  }
  await gitlab.bulkPublishDraftNotes(project, mr);
  return {
    posted: created.length,
    drafts: {
      abandoned: 0,
      created: created.length,
      deletedPrePublish: 0,
      published: created.length,
    },
  };
}
