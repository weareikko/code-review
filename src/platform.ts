import type { Config } from './config.js';
import type { Discussion } from './gitlab.js';
import {
  GitHubPlatform,
  parseGitHubPullNumber,
  parseGitHubRepository,
} from './platforms/github.js';
import { GitLabPlatform } from './platforms/gitlab.js';
import type { PostingMode, PostResult, SummaryResult, UpsertSummaryOptions } from './posting.js';
import type { DiffRefs, GeneratedComment, ReviewComment } from './types.js';

/**
 * The change under review, normalized across source-control platforms. Mirrors
 * the subset of a GitLab merge request (and a GitHub pull request) that the
 * review engine consumes: the branch pair plus the author's declared intent.
 */
export interface MergeRequestMeta {
  source_branch: string;
  target_branch: string;
  /** One-line declared intent of the change. May be empty. */
  title?: string;
  /** The author's full reasoning / decision log. May be empty or null. */
  description?: string | null;
}

/**
 * Minimal, telemetry-agnostic view of the most recent HTTP response a platform
 * issued. The diagnostics/OTel layer maps these onto HTTP semantic-convention
 * span attributes without coupling the seam to any observability SDK. Carries no
 * secrets — the auth token travels in a request header, never the URL.
 */
export interface ScmResponseInfo {
  method: string;
  url: string;
  status: number;
  /** Parsed Content-Length header in bytes, when the response provided one. */
  responseContentLength?: number;
}

/**
 * The seam every source-control backend implements so `run()` can drive a review
 * without knowing whether it is talking to GitLab or GitHub. The review core
 * (local-git diff, agent, prompt, skills, parser, fingerprints, dedup, summary
 * carryover) stays platform-agnostic; only target identification, reading
 * existing comments, and posting differ per platform and live behind this
 * interface.
 */
export interface ReviewPlatform {
  /** Fetch the change's branch pair and declared intent. */
  getMergeRequest(): Promise<MergeRequestMeta>;
  /**
   * Resolve the diff refs. On GitLab these are the MR version base/start/head
   * SHAs; `head_sha` is the reviewed commit used for the reviewed-commit skip
   * marker and the comment/summary footers.
   */
  getRefs(): Promise<DiffRefs>;
  /** Existing comments, normalized so the shared dedup/summary helpers work unchanged. */
  getDiscussions(): Promise<Discussion[]>;
  /** Turn parsed reviewer findings into platform-specific posting payloads. */
  buildComments(
    comments: ReviewComment[],
    diff: string,
    refs: DiffRefs,
    existingFingerprints: Set<string>,
  ): GeneratedComment[];
  /** Post (or draft-then-publish) the non-duplicate generated comments. */
  postComments(generated: GeneratedComment[], mode: PostingMode): Promise<PostResult>;
  /** Create or update the single MR-level summary note. */
  upsertSummary(
    summary: string,
    discussions: Discussion[],
    options: UpsertSummaryOptions,
  ): Promise<SummaryResult>;
  /**
   * The most recent HTTP response this platform issued, for telemetry stamping.
   * Returns `undefined` until the first request completes. Each request reports
   * a fresh object so a phase can compare identity and stamp only its own call.
   */
  lastResponse(): ScmResponseInfo | undefined;
}

/**
 * Build the {@link ReviewPlatform} for this run from the resolved config. The
 * platform was already selected (auto-detected from the environment or forced by
 * `--platform`/`CODE_REVIEW_PLATFORM`) during config resolution; this only
 * constructs the matching backend. GitHub target identifiers are parsed here so a
 * malformed `owner/repo` or pull number fails fast with an actionable hint.
 */
export function createPlatform(config: Config): ReviewPlatform {
  if (config.platform === 'github') {
    const { owner, repo } = parseGitHubRepository(config.githubRepository);
    return new GitHubPlatform({
      apiUrl: config.githubApiUrl,
      token: config.githubToken,
      owner,
      repo,
      pull: parseGitHubPullNumber(config.githubPr),
    });
  }
  return new GitLabPlatform(config);
}
