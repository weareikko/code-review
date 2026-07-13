import type { Config } from '../config.js';
import { type Discussion, GitLabClient } from '../gitlab.js';
import { buildGeneratedComments } from '../payloads.js';
import type { MergeRequestMeta, ReviewPlatform, ScmResponseInfo } from '../platform.js';
import {
  postGeneratedComments,
  type PostingMode,
  type PostResult,
  type SummaryResult,
  upsertSummaryNote,
  type UpsertSummaryOptions,
} from '../posting.js';
import type { DiffRefs, GeneratedComment, ReviewComment } from '../types.js';

/**
 * {@link ReviewPlatform} backed by the GitLab merge-request API. A thin wrapper
 * over the existing {@link GitLabClient}, `payloads.ts`, and `posting.ts`; it
 * carries no review logic of its own so GitLab behavior is byte-for-byte
 * identical to the pre-seam code path.
 */
export class GitLabPlatform implements ReviewPlatform {
  private readonly client: GitLabClient;
  private readonly project: string;
  private readonly mr: string;
  // Captures the most recent GitLab HTTP response so a traced phase can stamp
  // HTTP semconv attributes onto its span. Each request reports a fresh object.
  private last: ScmResponseInfo | undefined;

  constructor(config: Config) {
    this.project = config.project;
    this.mr = config.mr;
    this.client = new GitLabClient({
      gitlabUrl: config.gitlabUrl,
      token: config.gitlabToken,
      authHeader: config.gitlabAuthHeader,
      onResponse: (info) => {
        this.last = info;
      },
    });
  }

  lastResponse(): ScmResponseInfo | undefined {
    return this.last;
  }

  getMergeRequest(): Promise<MergeRequestMeta> {
    return this.client.getMergeRequest(this.project, this.mr);
  }

  async getRefs(): Promise<DiffRefs> {
    const version = await this.client.getLatestVersion(this.project, this.mr);
    return {
      base_sha: version.base_commit_sha,
      start_sha: version.start_commit_sha,
      head_sha: version.head_commit_sha,
    };
  }

  getDiscussions(): Promise<Discussion[]> {
    return this.client.getDiscussions(this.project, this.mr);
  }

  buildComments(
    comments: ReviewComment[],
    diff: string,
    refs: DiffRefs,
    existingFingerprints: Set<string>,
  ): GeneratedComment[] {
    return buildGeneratedComments(comments, diff, refs, existingFingerprints);
  }

  postComments(generated: GeneratedComment[], mode: PostingMode): Promise<PostResult> {
    return postGeneratedComments(this.client, this.project, this.mr, generated, mode);
  }

  upsertSummary(
    summary: string,
    discussions: Discussion[],
    options: UpsertSummaryOptions,
  ): Promise<SummaryResult> {
    return upsertSummaryNote(this.client, this.project, this.mr, summary, discussions, options);
  }
}
