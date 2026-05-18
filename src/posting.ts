import type { GitLabClient } from './gitlab.js';
import type { GeneratedComment } from './types.js';

export async function postGeneratedComments(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  generated: GeneratedComment[],
): Promise<number> {
  let posted = 0;
  for (const item of generated) {
    if (item.duplicate) continue;
    await gitlab.postDiscussion(project, mr, item.payload);
    posted += 1;
  }
  return posted;
}
