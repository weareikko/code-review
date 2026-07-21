import { contextLineWithinGitHubDiff, resolveDiffLine } from '../diff-lines.js';
import { ConfigError, GitHubApiError } from '../errors.js';
import { appendFingerprintMarkers, extractDiffHunkContext, fingerprints } from '../fingerprints.js';
import {
  GitHubClient,
  type IssueComment,
  type PullRequest,
  type PullRequestReviewComment,
} from '../github.js';
import type { Discussion, DiscussionNote, DiscussionNotePosition } from '../gitlab.js';
import { buildCommentBody } from '../payloads.js';
import type { MergeRequestMeta, ReviewPlatform, ScmResponseInfo } from '../platform.js';
import {
  buildUpsertSummary,
  type PostingMode,
  type PostResult,
  type SummaryResult,
  type UpsertSummaryOptions,
} from '../posting.js';
import type { DiffRefs, GeneratedComment, ReviewComment, Side } from '../types.js';

/**
 * A single inline comment in a batched GitHub review, positioned against the
 * diff. GitHub takes one `line` plus a `side` (unlike GitLab's two-sided
 * position). Built by {@link buildGitHubReviewPayload}; `null` when the finding
 * cannot be anchored to the diff (see {@link buildGitHubComments}).
 */
export interface GitHubReviewCommentPayload {
  path: string;
  body: string;
  line: number;
  side: Side;
}

/** The `owner` and `repo` halves of a GitHub `owner/repo` slug. */
export interface GitHubRepository {
  owner: string;
  repo: string;
}

/**
 * Split a `GITHUB_REPOSITORY` slug into its `owner` and `repo` halves. GitHub
 * repository slugs contain exactly one `/` (neither owner nor repo may be empty
 * or contain a slash), so anything else is a configuration error surfaced with an
 * actionable hint rather than a confusing 404 from the API.
 */
export function parseGitHubRepository(slug: string): GitHubRepository {
  const trimmed = slug.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash !== trimmed.lastIndexOf('/') || slash === trimmed.length - 1) {
    throw new ConfigError(`Invalid GitHub repository "${slug}"; expected "owner/repo".`, {
      hint: 'Set GITHUB_REPOSITORY (or --github-repository) to an "owner/repo" slug, e.g. octocat/hello-world.',
    });
  }
  return { owner: trimmed.slice(0, slash), repo: trimmed.slice(slash + 1) };
}

/**
 * Parse a pull-request number from its string form. Rejects non-integer or
 * non-positive values so a malformed `--pr`/`GITHUB_REF` fails fast with a hint
 * instead of hitting `/pulls/NaN`.
 */
export function parseGitHubPullNumber(value: string): number {
  const pull = Number(value.trim());
  if (!Number.isInteger(pull) || pull <= 0) {
    throw new ConfigError(`Invalid GitHub pull-request number "${value}".`, {
      hint: 'The pull-request number comes from the pull_request event payload, GITHUB_REF (refs/pull/N/merge), or --pr; it must be a positive integer.',
    });
  }
  return pull;
}

/** What a {@link GitHubPlatform} needs to talk to one pull request. */
export interface GitHubPlatformOptions {
  /** REST API base (default `https://api.github.com`; GHE sets an `/api/v3` base). */
  apiUrl?: string;
  token: string;
  owner: string;
  repo: string;
  /** Pull-request number. */
  pull: number;
  fetchImpl?: typeof fetch;
  requestTimeout?: number;
}

/**
 * Resolve one reviewer finding to a GitHub review-comment payload, or `null`
 * when it cannot be anchored to GitHub's diff. GitHub uses a single `line` +
 * `side`:
 *   - a pure added line takes the new-file line with `side: 'RIGHT'`,
 *   - a pure removed line takes the old-file line with `side: 'LEFT'`,
 *   - an unchanged (context) line takes the new-file line with `side: 'RIGHT'`,
 *     regardless of the finding's side — GitHub's API prescribes RIGHT for
 *     "unchanged lines ... shown for context", so a LEFT context comment is
 *     doc-noncompliant and risks a 422.
 *
 * Returning `null` for an off-diff line is deliberate: GitHub answers 422 when a
 * review comment points at a line outside the diff, and one such comment fails
 * the whole batched review, so the poster drops these rather than post them. A
 * context line is only kept when it lies within GitHub's default 3-line hunk
 * context of a change — our local diff carries far more context (`--unified=20`)
 * than GitHub's PR diff, so a distant context line is inside our diff but off
 * GitHub's.
 */
export function buildGitHubReviewPayload(
  comment: ReviewComment,
  body: string,
  diff: string,
): GitHubReviewCommentPayload | null {
  const resolved = resolveDiffLine(diff, comment.file, comment.line, comment.side);
  if (!resolved) return null;
  // A context line resolves to BOTH sides. GitHub only shows context lines close
  // to a change and wants them on the RIGHT side.
  if (resolved.oldLine !== undefined && resolved.newLine !== undefined) {
    if (!contextLineWithinGitHubDiff(diff, comment.file, comment.line, comment.side)) return null;
    return { path: comment.file, body, line: resolved.newLine, side: 'RIGHT' };
  }
  if (comment.side === 'LEFT') {
    if (resolved.oldLine === undefined) return null;
    return { path: comment.file, body, line: resolved.oldLine, side: 'LEFT' };
  }
  if (resolved.newLine === undefined) return null;
  return { path: comment.file, body, line: resolved.newLine, side: 'RIGHT' };
}

/**
 * Turn parsed reviewer findings into GitHub review-comment payloads, mirroring
 * the GitLab `buildGeneratedComments` contract: same hunk-context fingerprints,
 * same dedup semantics, same comment body/footer. The payload is
 * `GitHubReviewCommentPayload | null` — `null` for a finding that cannot be
 * placed on the diff, which the poster skips.
 */
export function buildGitHubComments(
  comments: ReviewComment[],
  diff: string,
  refs: DiffRefs,
  existingFingerprints: Set<string>,
): GeneratedComment<GitHubReviewCommentPayload | null>[] {
  const seen = new Set(existingFingerprints);

  return comments.map((comment) => {
    const hunk = extractDiffHunkContext(diff, comment.file, comment.line, comment.side);
    const fp = fingerprints(comment, hunk);
    const duplicate = seen.has(fp.primary) || seen.has(fp.secondary);
    seen.add(fp.primary);
    seen.add(fp.secondary);

    // Fingerprints hash comment.body (raw reviewer output) before the footer is
    // appended, so dedup is stable across runs even as the commit SHA changes.
    const bodyWithFooter = buildCommentBody(comment.body, refs.head_sha, comment.confidence);
    const payload = buildGitHubReviewPayload(
      comment,
      appendFingerprintMarkers(bodyWithFooter, fp),
      diff,
    );

    return { comment, fingerprints: fp, duplicate, payload };
  });
}

/**
 * Map a positioned GitHub review comment onto a normalized {@link DiscussionNote}
 * position. GitHub carries a single `path` for the file, so both sides get it;
 * only the line side matching the comment is populated. This mirrors the GitLab
 * shape the shared helpers (`extractPriorThreads`, reviewed-commit scan) expect:
 * `positionFile` prefers `new_path`, `positionLine` prefers `new_line`.
 */
function reviewCommentPosition(comment: PullRequestReviewComment): DiscussionNotePosition {
  const line = comment.line ?? comment.original_line ?? null;
  const path = comment.path ?? null;
  const isLeft = (comment.side ?? 'RIGHT').toUpperCase() === 'LEFT';
  return {
    old_path: path,
    new_path: path,
    ...(isLeft ? { old_line: line } : { new_line: line }),
  };
}

/**
 * Normalize GitHub's two comment streams into the {@link Discussion}[] shape the
 * platform-agnostic helpers consume unchanged:
 *   - Inline **review comments** are threaded by `in_reply_to_id` (a reply joins
 *     its root comment's discussion, in arrival order) so `extractPriorThreads`
 *     sees a bot note followed by human replies, exactly like GitLab.
 *   - Non-positional **issue comments** each become a single-note discussion;
 *     the MR-level summary note lives here and is found via its summary marker.
 *
 * The fingerprint markers, summary marker, and reviewed-commit footer are HTML
 * comments that render identically on GitHub, so `extractExistingFingerprints`,
 * `findExistingSummaryNote`, and the reviewed-commit scan all work as-is.
 *
 * `settledCommentIds` carries the database ids of comments in settled review
 * threads — resolved or outdated (from the GraphQL `reviewThreads` query, since
 * REST omits both). Each such note gets a `resolved` flag mirroring GitLab's
 * per-note field: an outdated GitHub thread maps to `resolved: true` because
 * GitHub, unlike GitLab, does not auto-resolve a thread when its anchored line
 * changes, so treating outdated as resolved matches GitLab's behaviour (#133).
 */
export function normalizeGitHubDiscussions(
  reviewComments: PullRequestReviewComment[],
  issueComments: IssueComment[],
  settledCommentIds: Set<number> = new Set(),
): Discussion[] {
  const threads = new Map<number, DiscussionNote[]>();
  const order: number[] = [];

  for (const comment of reviewComments) {
    const rootId = comment.in_reply_to_id ?? comment.id;
    let notes = threads.get(rootId);
    if (!notes) {
      notes = [];
      threads.set(rootId, notes);
      order.push(rootId);
    }
    notes.push({
      id: comment.id,
      body: comment.body ?? '',
      // GitHub's REST comments carry no resolution state; it comes from the
      // GraphQL `reviewThreads` query, keyed by comment database id. A settled
      // (resolved or outdated) thread marks all its comments, so any note being
      // settled flags the whole thread for the shared `notes.some((n) => n.resolved)`
      // checks.
      resolved: settledCommentIds.has(comment.id),
      position: reviewCommentPosition(comment),
    });
  }

  const discussions: Discussion[] = order.map((rootId) => ({ notes: threads.get(rootId) ?? [] }));

  for (const comment of issueComments) {
    discussions.push({ notes: [{ id: comment.id, body: comment.body ?? '' }] });
  }

  return discussions;
}

/**
 * {@link ReviewPlatform} backed by the GitHub pull-request API. Positioned
 * findings post as ONE batched review (`event: 'COMMENT'`) — atomic and free of
 * per-comment secondary rate limits — and the MR-level summary is upserted as a
 * single issue comment. The review core is unchanged; only target
 * identification, reading existing comments, and posting differ from GitLab.
 */
export class GitHubPlatform implements ReviewPlatform {
  private readonly client: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;
  private readonly pull: number;
  // Captures the most recent GitHub HTTP response so a traced phase can stamp
  // HTTP semconv attributes onto its span. Each request reports a fresh object.
  private last: ScmResponseInfo | undefined;
  // The pull request is fetched once and reused for both branch metadata and the
  // head SHA (GitHub returns both from one endpoint). Memoized so the two phases
  // do not double-fetch.
  private pullRequestPromise: Promise<PullRequest> | undefined;
  // Reviewed commit id for the batched review's `commit_id`, captured from the
  // resolved refs (`head_sha`) before `postComments` runs.
  private commitId: string | undefined;

  constructor(options: GitHubPlatformOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.pull = options.pull;
    this.client = new GitHubClient({
      apiUrl: options.apiUrl,
      token: options.token,
      fetchImpl: options.fetchImpl,
      requestTimeout: options.requestTimeout,
      onResponse: (info) => {
        this.last = info;
      },
    });
  }

  lastResponse(): ScmResponseInfo | undefined {
    return this.last;
  }

  private pullRequest(): Promise<PullRequest> {
    if (!this.pullRequestPromise) {
      this.pullRequestPromise = this.client.getPullRequest(this.owner, this.repo, this.pull);
    }
    return this.pullRequestPromise;
  }

  async getMergeRequest(): Promise<MergeRequestMeta> {
    const pr = await this.pullRequest();
    return {
      source_branch: pr.head.ref,
      target_branch: pr.base.ref,
      title: pr.title,
      description: pr.body,
    };
  }

  async getRefs(): Promise<DiffRefs> {
    const pr = await this.pullRequest();
    // GitHub reviews are positioned against a single commit id, not a base/start
    // pair; head SHA is that commit. base/start are unused by the GitHub poster
    // but populated so the DiffRefs shape stays uniform across platforms.
    const refs: DiffRefs = {
      base_sha: pr.base.sha,
      start_sha: pr.base.sha,
      head_sha: pr.head.sha,
    };
    this.commitId = refs.head_sha;
    return refs;
  }

  async getDiscussions(): Promise<Discussion[]> {
    const [reviewComments, issueComments, settledCommentIds] = await Promise.all([
      this.client.listReviewComments(this.owner, this.repo, this.pull),
      this.client.listIssueComments(this.owner, this.repo, this.pull),
      this.client.listSettledReviewCommentIds(this.owner, this.repo, this.pull),
    ]);
    return normalizeGitHubDiscussions(reviewComments, issueComments, settledCommentIds);
  }

  buildComments(
    comments: ReviewComment[],
    diff: string,
    refs: DiffRefs,
    existingFingerprints: Set<string>,
  ): GeneratedComment[] {
    this.commitId = refs.head_sha;
    return buildGitHubComments(comments, diff, refs, existingFingerprints);
  }

  // GitHub has no draft-then-publish flow: a batched review is already atomic, so
  // `mode` is accepted for interface parity but does not change behavior.
  async postComments(generated: GeneratedComment[], _mode: PostingMode): Promise<PostResult> {
    const comments = generated
      .filter((item) => !item.duplicate)
      .map((item) => item.payload as GitHubReviewCommentPayload | null)
      .filter((payload): payload is GitHubReviewCommentPayload => payload !== null)
      .map(({ path, body, line, side }) => ({ path, body, line, side }));

    if (comments.length === 0) return { posted: 0 };

    if (this.commitId === undefined) {
      throw new GitHubApiError('Cannot post a GitHub review before the head commit is resolved', {
        method: 'POST',
        path: `/repos/${this.owner}/${this.repo}/pulls/${this.pull}/reviews`,
        hint: 'Call getRefs()/buildComments() to resolve refs before postComments().',
      });
    }
    const commitId = this.commitId;

    try {
      await this.client.createReview(this.owner, this.repo, this.pull, {
        commit_id: commitId,
        event: 'COMMENT',
        comments,
      });
      return { posted: comments.length };
    } catch (batchError) {
      // GitHub 422s the ENTIRE batched review if a single comment lands off its
      // diff, losing every finding. We already guard positions locally, but as
      // defense-in-depth (mirroring the GitLab draft `publishFailed` fallback)
      // retry each comment as its own single-comment review so valid findings
      // still land and only the rejected ones are dropped. Re-throw the original
      // error when every retry also fails, so a genuinely broken run surfaces.
      if (!(batchError instanceof GitHubApiError) || batchError.status !== 422) throw batchError;
      const results = await Promise.allSettled(
        comments.map((comment) =>
          this.client.createReview(this.owner, this.repo, this.pull, {
            commit_id: commitId,
            event: 'COMMENT',
            comments: [comment],
          }),
        ),
      );
      const posted = results.filter((result) => result.status === 'fulfilled').length;
      if (posted === 0) throw batchError;
      return { posted };
    }
  }

  async upsertSummary(
    summary: string,
    discussions: Discussion[],
    options: UpsertSummaryOptions,
  ): Promise<SummaryResult> {
    const { body, existing } = buildUpsertSummary(summary, discussions, options);
    if (existing) {
      await this.client.updateIssueComment(this.owner, this.repo, existing.id, body);
      return { action: 'updated', noteId: existing.id };
    }
    const created = await this.client.createIssueComment(this.owner, this.repo, this.pull, body);
    return { action: 'created', noteId: created.id };
  }
}
