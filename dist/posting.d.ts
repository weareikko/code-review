import type { GitLabClient } from './gitlab.js';
import type { GeneratedComment } from './types.js';
export declare function postGeneratedComments(gitlab: GitLabClient, project: string, mr: string, generated: GeneratedComment[]): Promise<number>;
