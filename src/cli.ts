import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from './config.js';
import { applyGitLabReviewEnvPrefix, resolveConfig, validateConfig } from './config.js';
import {
  createDiagnosticRunId,
  traceDiagnosticPhase,
  type DiagnosticContext,
  type DiagnosticPhase,
} from './diagnostics.js';
import { formatError, isQuotaExceededError, ParseError, RuntimeError } from './errors.js';
import { extractExistingFingerprints } from './fingerprints.js';
import { getMergeCommitLog, getMergeDiff, prepareGitHistory, summarizeDiff } from './git.js';
import type { ReviewUsage } from './gitlab-review.js';
import { runReview } from './gitlab-review.js';
import { GitLabClient, type GitLabResponseInfo } from './gitlab.js';
import { createLogger } from './logger.js';
import type { OtelBridge } from './otel.js';
import { startOtelBridge } from './otel.js';
import { parseReviewMarkdownWithWarnings } from './parser.js';
import { buildGeneratedComments } from './payloads.js';
import type { SummaryResult } from './posting.js';
import {
  findExistingReviewedCommitSha,
  postGeneratedComments,
  upsertSummaryNote,
} from './posting.js';
import { extractChangedFiles, extractPriorThreads } from './prior-threads.js';
import type { DiffRefs, GeneratedComment, Severity } from './types.js';

export type {
  DiagnosticContext,
  DiagnosticError,
  DiagnosticPhase,
  DiagnosticUsage,
  DiagnosticUsageBreakdown,
} from './diagnostics.js';
export {
  DIAGNOSTIC_CHANNEL_NAMES,
  DIAGNOSTIC_CHANNEL_PREFIX,
  createDiagnosticContext,
  createDiagnosticRunId,
  diagnosticChannels,
  traceDiagnostic,
  traceDiagnosticPhase,
} from './diagnostics.js';
export type { OtelBridge, OtelBridgeOptions, OtelRuntime } from './otel.js';
export { isOtelEnabled, startOtelBridge } from './otel.js';

const HELP = `Usage: gitlab-review [options]

Run gitlab-review in GitLab CI and post deduplicated merge request discussions.

Options:
  --project <id>          GitLab project ID/path (default: CI_PROJECT_ID)
  --mr <iid>              Merge request IID (default: CI_MERGE_REQUEST_IID)
  --gitlab-url <url>      GitLab URL (default: CI_SERVER_URL or CI_SERVER_HOST)
  --gitlab-token <token>  GitLab token (default: GITLAB_TOKEN, GLAB_CLI_TOKEN, CI_JOB_TOKEN, GITLAB_PRIVATE_TOKEN)
  --api-key <key>         AI API key. Required, except for providers with ambient
                          credentials or local endpoints (e.g. Ollama). Resolved from the
                          provider's standard env var (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY,
                          GEMINI_API_KEY, OPENROUTER_API_KEY) or this flag.
  --model <provider/id>   Model to use. Format: provider/modelId. Multi-slash IDs such as
                          openrouter/anthropic/claude-3-opus are supported by splitting on the
                          first slash. Use ollama/<model> for local Ollama models.
                          (required; env: GITLAB_REVIEW_MODEL)
  --model-pool <list>     Comma-separated provider/modelId list for heterogeneous full-depth
                          review. Angles map to pool members (angle i → member i % pool size)
                          and each finding is verified by a model other than its author. Each
                          member resolves its own provider key; members without a key are
                          dropped with a warning. Empty (default) = single model = no change.
                          (env: GITLAB_REVIEW_MODEL_POOL)
  --base-url <url>        Override the provider base URL (e.g. a custom OpenAI-compatible
                          endpoint). For Ollama, set OLLAMA_HOST instead.
                          (env: GITLAB_REVIEW_BASE_URL)
  --max-tokens <n>        Override maximum output tokens for the model. 0 = model default.
                          (env: GITLAB_REVIEW_MAX_TOKENS)
  --max-diff-chars <n>    Cumulative diff char budget sent to the reviewer. Files past this
                          budget are dropped and surfaced as a size-skip callout. (default: 100000)
                          (env: GITLAB_REVIEW_MAX_DIFF_CHARS)
  --decompose-hint-lines <n>
                          When > 0, an MR whose reviewed diff changes more lines than this
                          threshold gets a "consider decomposing this MR" note in the summary.
                          0 = off (default). (env: GITLAB_REVIEW_DECOMPOSE_HINT_LINES)
  --min-severity <level>  info, warn, or critical (default: info)
  --thinking <level>      off, minimal, low, medium, high, or xhigh (default: off).
                          Higher levels add billable thinking tokens at the model output rate.
  --review-depth <depth>  single (one pass), verify (adversarial re-check of each
                          severe finding), or full (multi-angle finders → triage →
                          verify). (default: single; env: GITLAB_REVIEW_DEPTH)
  --posting-mode <mode>   direct (sequential discussions) or draft (atomic bulk publish)
                          (default: direct)
  --review-file <path>    Raw gitlab-review output file (default: gitlab-review.md)
  --output <path>         Generated payload artifact (default: review-comments.json)
  --cwd <path>            Working directory (default: process.cwd())
  --dry-run               Generate artifacts and skip posting
  --no-post               Generate artifacts and skip posting
  --no-summary            Skip posting/updating the MR-level summary note
                          (env: GITLAB_REVIEW_POST_SUMMARY=false)
  --force-review          Run even when the current commit was already reviewed
                          (env: GITLAB_REVIEW_FORCE_REVIEW=true)
  --verbose               Enable debug-level logging
                          (env: GITLAB_REVIEW_VERBOSE=true)
  --help, -h              Show help
  --version, -v           Show version
`;

export interface RunResult {
  generated: GeneratedComment[];
  posted: number;
  usage: ReviewUsage;
  summary: SummaryResult | null;
  skipped?: boolean;
}

declare const __PKG_NAME__: string;
declare const __PKG_VERSION__: string;

function assertNodeVersion(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new RuntimeError(
      `Node.js >=24 is required; current version is ${process.versions.node}.`,
      {
        hint: 'Use a Node 24 image/runtime in GitLab CI.',
      },
    );
  }
}

function refsFromVersion(version: {
  base_commit_sha: string;
  start_commit_sha: string;
  head_commit_sha: string;
}): DiffRefs {
  return {
    base_sha: version.base_commit_sha,
    start_sha: version.start_commit_sha,
    head_sha: version.head_commit_sha,
  };
}

export interface RunBridges {
  /** Pre-started OTel bridge for per-turn and per-tool-call agent telemetry. */
  otel?: OtelBridge;
}

/**
 * Write the empty/skip artifacts (comment JSON, usage, and a one-line review
 * note) for a run that produced no review — a re-reviewed commit or a provider
 * credit/quota skip. Keeps the dry-run/no-post contract: artifacts only, no
 * posting.
 */
async function writeSkipArtifacts(
  config: Config,
  usage: ReviewUsage,
  reviewNote: string,
): Promise<void> {
  const outputPath = resolve(config.cwd, config.output);
  const usagePath = resolve(config.cwd, 'review-usage.json');
  const reviewPath = resolve(config.cwd, config.reviewFile);
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify([], null, 2), 'utf8');
  await writeFile(usagePath, JSON.stringify(usage, null, 2), 'utf8');
  await writeFile(reviewPath, reviewNote, 'utf8');
}

export async function run(config: Config, bridges?: RunBridges): Promise<RunResult> {
  validateConfig(config);

  const logger = createLogger(config.verbose ? 'debug' : 'info');
  const runId = createDiagnosticRunId();
  return traceDiagnosticPhase('run', config, runId, async (runContext) => {
    // Captures the most recent GitLab HTTP response so each traced read phase
    // can stamp HTTP semconv attributes onto its span. Each request reports a
    // fresh object, so a phase compares the holder against its pre-call value
    // and only stamps when its own request actually produced a response.
    let lastHttp: GitLabResponseInfo | undefined;
    const gitlab = new GitLabClient({
      gitlabUrl: config.gitlabUrl,
      token: config.gitlabToken,
      authHeader: config.gitlabAuthHeader,
      onResponse: (info) => {
        lastHttp = info;
      },
    });
    // Wraps a single-request (or paginated) GitLab read so the phase span gets
    // HTTP attributes on both success and error paths.
    const tracedRead = <T>(phase: DiagnosticPhase, fn: () => Promise<T>): Promise<T> =>
      traceDiagnosticPhase(
        phase,
        config,
        runId,
        withHttpStamping(
          () => lastHttp,
          () => fn(),
        ),
      );

    logger.info('Fetching MR info...');
    const mr = await tracedRead('gitlab.get_merge_request', () =>
      gitlab.getMergeRequest(config.project, config.mr),
    );
    const version = await tracedRead('gitlab.get_latest_version', () =>
      gitlab.getLatestVersion(config.project, config.mr),
    );
    const initialDiscussions = await tracedRead('gitlab.get_discussions', () =>
      gitlab.getDiscussions(config.project, config.mr),
    );

    const reviewedCommitSha = findExistingReviewedCommitSha(initialDiscussions);
    if (
      !config.forceReview &&
      !config.dryRun &&
      !config.noPost &&
      reviewedCommitSha === version.head_commit_sha
    ) {
      const usage = zeroReviewUsage(config.model);
      runContext.usage = usage;
      runContext.generated = 0;
      runContext.newComments = 0;
      runContext.duplicateComments = 0;
      runContext.posted = 0;
      runContext.summaryAction = 'skipped';

      await traceDiagnosticPhase('artifact.write_output', config, runId, async (context) => {
        await writeSkipArtifacts(
          config,
          usage,
          `Skipped review: commit ${version.head_commit_sha} was already reviewed.\n`,
        );
        context.generated = 0;
        context.newComments = 0;
        context.duplicateComments = 0;
        context.posted = 0;
      });

      console.log(
        `Skipping review: commit ${version.head_commit_sha} was already reviewed. Use --force-review to run again.`,
      );
      return { generated: [], posted: 0, usage, summary: null, skipped: true };
    }

    logger.info('Fetching diff...');
    await traceDiagnosticPhase('git.prepare_history', config, runId, () =>
      prepareGitHistory(mr.source_branch, mr.target_branch, { cwd: config.cwd }),
    );
    const diff = await traceDiagnosticPhase(
      'git.get_merge_diff',
      config,
      runId,
      async (context) => {
        const merged = await getMergeDiff(mr.target_branch, { cwd: config.cwd });
        const summary = summarizeDiff(merged);
        context.diffFilesChanged = summary.filesChanged;
        context.diffLinesAdded = summary.linesAdded;
        context.diffLinesRemoved = summary.linesRemoved;
        return merged;
      },
    );
    const commitLog = await traceDiagnosticPhase('git.get_commit_log', config, runId, () =>
      getMergeCommitLog(mr.target_branch, { cwd: config.cwd }),
    );
    const changedFiles = extractChangedFiles(diff);
    const priorThreads = extractPriorThreads(initialDiscussions, changedFiles);
    if (priorThreads.length > 0) {
      logger.info(
        `Found ${priorThreads.length} prior thread(s) with developer replies — including as context.`,
      );
    }

    logger.info('Running review...');
    let usage: ReviewUsage;
    try {
      usage = await traceDiagnosticPhase('reviewer.run', config, runId, async (context) => {
        const result = await runReview(config, {
          cwd: config.cwd,
          diff,
          commitLog,
          priorThreads,
          intent: { title: mr.title, description: mr.description },
          logger,
          // Subscribe the OTel bridge to the agent's event stream so per-turn
          // and per-tool-call spans/metrics fire in real time.
          attachTelemetry: bridges?.otel?.createAgentTelemetry(runId),
        });
        context.usage = result;
        return result;
      });
    } catch (error) {
      // A provider credit/quota exhaustion (e.g. HTTP 402) means the review
      // could not run for reasons outside the MR's control. Warn and skip
      // rather than failing the pipeline, so a billing dead-end does not block
      // every MR. Any other error still propagates and fails the job.
      if (!isQuotaExceededError(error)) throw error;
      const skipUsage = zeroReviewUsage(config.model);
      runContext.usage = skipUsage;
      runContext.generated = 0;
      runContext.newComments = 0;
      runContext.duplicateComments = 0;
      runContext.posted = 0;
      runContext.summaryAction = 'skipped';
      await traceDiagnosticPhase('artifact.write_output', config, runId, async (context) => {
        await writeSkipArtifacts(
          config,
          skipUsage,
          'Skipped review: model provider out of credits/quota.\n',
        );
        context.generated = 0;
        context.newComments = 0;
        context.duplicateComments = 0;
        context.posted = 0;
      });
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[gitlab-review] Skipping review: model provider out of credits/quota — not failing the pipeline. (${detail})`,
      );
      return { generated: [], posted: 0, usage: skipUsage, summary: null, skipped: true };
    }
    runContext.usage = usage;

    const reviewPath = resolve(config.cwd, config.reviewFile);
    const { parsed } = await traceDiagnosticPhase(
      'review.parse',
      config,
      runId,
      async (context) => {
        const review = await readFile(reviewPath, 'utf8');
        const result = parseReviewMarkdownWithWarnings(review);
        context.generated = result.comments.length;
        context.warnings = result.warnings.length;
        if (result.malformed) {
          context.malformedReason = result.malformed.reason;
          throw new ParseError(
            `The reviewer output in ${config.reviewFile} contains a JSON block that could not be parsed [${result.malformed.reason}] (commonly an unescaped quote, backslash, or newline inside a string value). Preview: ${result.malformed.preview}`,
            {
              hint: `Inspect the ${config.reviewFile} artifact for invalid JSON and re-run the review. Failing here avoids marking the job successful with an empty review.`,
            },
          );
        }
        return { parsed: result };
      },
    );
    for (const warning of parsed.warnings) console.warn(`[gitlab-review] ${warning}`);

    const discussions = await tracedRead('gitlab.get_discussions', () =>
      gitlab.getDiscussions(config.project, config.mr),
    );
    const existing = extractExistingFingerprints(discussions);
    const generated = await traceDiagnosticPhase(
      'comments.build',
      config,
      runId,
      async (context) => {
        const comments = buildGeneratedComments(
          parsed.comments,
          diff,
          refsFromVersion(version),
          existing,
        );
        recordCommentCounts(context, comments);
        return comments;
      },
    );

    const outputPath = resolve(config.cwd, config.output);
    const usagePath = resolve(config.cwd, 'review-usage.json');
    await traceDiagnosticPhase('artifact.write_output', config, runId, async (context) => {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(generated, null, 2), 'utf8');
      await writeFile(usagePath, JSON.stringify(usage, null, 2), 'utf8');
      recordCommentCounts(context, generated);
    });

    console.log(formatUsageLine(usage));
    const perModel = formatPerModelUsage(usage);
    if (perModel) console.log(perModel);

    const newCount = generated.filter((item) => !item.duplicate).length;
    recordCommentCounts(runContext, generated);
    bridges?.otel?.logComments(generated, runId);
    logger.info(`Posting ${newCount} new comment(s)...`);
    if (config.dryRun || config.noPost) {
      console.log(`Generated ${generated.length} comments, ${newCount} new. Posting disabled.`);
      if (config.postSummary && parsed.summary) {
        console.log('Summary note generated but not posted (posting disabled).');
      }
      runContext.posted = 0;
      return { generated, posted: 0, usage, summary: null };
    }

    let summary: SummaryResult | null = null;
    if (config.postSummary && parsed.summary) {
      summary = await traceDiagnosticPhase(
        'gitlab.upsert_summary',
        config,
        runId,
        withHttpStamping(
          () => lastHttp,
          async (context) => {
            const result = await upsertSummaryNote(
              gitlab,
              config.project,
              config.mr,
              parsed.summary as string,
              discussions,
              {
                costFooter: formatUsageLine(usage),
                skillsFooter: formatSkillsFooter(usage.skills),
                reviewedCommitSha: version.head_commit_sha,
                runId,
                sizeNotice: usage.sizeNotice,
              },
            );
            context.summaryAction = result.action;
            context.summaryNoteId = result.noteId;
            return result;
          },
        ),
      );
      runContext.summaryAction = summary.action;
      runContext.summaryNoteId = summary.noteId;
      console.log(
        summary.action === 'updated'
          ? `Updated MR summary note (id ${summary.noteId}).`
          : `Posted MR summary note (id ${summary.noteId}).`,
      );
    } else if (config.postSummary && !parsed.summary) {
      console.log('No summary returned by the reviewer; skipping summary note.');
    }

    let draftsPublishFailed = 0;
    let raceLost = 0;
    const posted = await traceDiagnosticPhase(
      'gitlab.post_comments',
      config,
      runId,
      withHttpStamping(
        () => lastHttp,
        async (context) => {
          const result = await postGeneratedComments(
            gitlab,
            config.project,
            config.mr,
            generated,
            config.postingMode,
          );
          recordCommentCounts(context, generated);
          context.posted = result.posted;
          if (result.drafts) {
            context.draftsAbandoned = result.drafts.abandoned;
            context.draftsCreated = result.drafts.created;
            context.draftsDeletedPrePublish = result.drafts.deletedPrePublish;
            context.draftsPublished = result.drafts.published;
            context.draftsPublishFailed = result.drafts.publishFailed;
            draftsPublishFailed = result.drafts.publishFailed;
            raceLost = result.drafts.deletedPrePublish;
          }
          return result.posted;
        },
      ),
    );
    const duplicates = generated.length - newCount;
    const raceExtra = raceLost > 0 ? `, ${raceLost} dropped by pre-publish re-check` : '';
    console.log(
      `Posted ${posted} new GitLab MR discussions (${duplicates} duplicates skipped${raceExtra}).`,
    );
    if (draftsPublishFailed > 0) {
      console.warn(
        `[gitlab-review] ${draftsPublishFailed} comment(s) could not be published individually after bulk_publish failed and were dropped.`,
      );
    }
    runContext.posted = posted;
    runContext.draftsPublishFailed = draftsPublishFailed;
    if (posted > 0) runContext.postedBySeverity = countPostedBySeverity(generated);

    return { generated, posted, usage, summary };
  });
}

function zeroReviewUsage(model: string): ReviewUsage {
  return {
    model,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    skills: [],
    sizeNotice: { sizeSkippedFiles: [] },
  };
}

export function formatSkillsFooter(skills: string[]): string | undefined {
  if (skills.length === 0) return undefined;
  return `Skills: ${skills.map((s) => `\`${s}\``).join(', ')}`;
}

export function formatUsageLine(usage: ReviewUsage): string {
  const formatter = new Intl.NumberFormat('en-US');
  const billableInput = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite;
  const inputLabel =
    usage.tokens.cacheRead > 0
      ? `${formatter.format(billableInput)} in (${formatter.format(usage.tokens.cacheRead)} cached)`
      : `${formatter.format(billableInput)} in`;
  const output = formatter.format(usage.tokens.output);
  const cost = usage.cost.total.toFixed(4);
  return `Review usage: ${inputLabel} / ${output} out tokens — $${cost} (${usage.model})`;
}

/**
 * Render the per-model usage breakdown for heterogeneous `full`-depth runs: one
 * indented line per pool member with its billable input / output tokens and
 * cost. Returns `undefined` when there is no breakdown (single-model runs), so
 * the caller prints nothing extra. Surfaces model ids and numbers only — never
 * any key or secret.
 */
export function formatPerModelUsage(usage: ReviewUsage): string | undefined {
  if (!usage.byModel || usage.byModel.length < 2) return undefined;
  const formatter = new Intl.NumberFormat('en-US');
  const lines = usage.byModel.map((entry) => {
    const billableInput = entry.tokens.input + entry.tokens.cacheRead + entry.tokens.cacheWrite;
    const input = formatter.format(billableInput);
    const out = formatter.format(entry.tokens.output);
    const cost = entry.cost.total.toFixed(4);
    return `  - ${entry.model}: ${input} in / ${out} out tokens — $${cost}`;
  });
  return ['Per-model usage:', ...lines].join('\n');
}

function recordCommentCounts(context: DiagnosticContext, generated: GeneratedComment[]): void {
  context.generated = generated.length;
  context.newComments = generated.filter((item) => !item.duplicate).length;
  context.duplicateComments = generated.length - context.newComments;
}

/**
 * Wraps a phase operation so the phase context gets HTTP semantic-convention
 * attributes stamped from the most recent GitLab response — on both success and
 * error paths. `readLastHttp` returns the holder updated by the client's
 * `onResponse` callback; the wrapper snapshots it before the operation and only
 * stamps when the operation's own request produced a *new* response, so a phase
 * that threw before any HTTP call never inherits a previous phase's URL/status.
 *
 * Used by every traced GitLab phase, including the write phases
 * (`gitlab.post_comments`, `gitlab.upsert_summary`) so a failure like a 500 on
 * `bulk_publish` carries http.response.status_code / url.full / server.address.
 */
export function withHttpStamping<T>(
  readLastHttp: () => GitLabResponseInfo | undefined,
  operation: (context: DiagnosticContext) => Promise<T>,
): (context: DiagnosticContext) => Promise<T> {
  return async (context) => {
    const before = readLastHttp();
    try {
      return await operation(context);
    } finally {
      const last = readLastHttp();
      if (last !== before) applyHttpContext(context, last);
    }
  };
}

/**
 * Stamp HTTP semantic-convention fields from a captured GitLab response onto a
 * diagnostic phase context. The OTel bridge maps these to http.* / url.full /
 * server.address span attributes. No-op when no response was captured.
 */
function applyHttpContext(context: DiagnosticContext, info: GitLabResponseInfo | undefined): void {
  if (!info) return;
  context.httpRequestMethod = info.method;
  context.httpUrl = info.url;
  context.httpStatusCode = info.status;
  if (info.responseContentLength !== undefined) {
    context.httpResponseBodySize = info.responseContentLength;
  }
  try {
    context.serverAddress = new URL(info.url).hostname;
  } catch {
    // Malformed URL — leave server.address unset rather than throwing in telemetry.
  }
}

/**
 * Count the comments posted to the MR, grouped by severity. Duplicates are
 * excluded since they are never posted. The total equals the new-comment count;
 * in `draft` mode a concurrent run can race-delete some drafts before publish,
 * so the breakdown reflects posted intent and may slightly exceed the published
 * count in that rare case.
 */
export function countPostedBySeverity(
  generated: GeneratedComment[],
): Partial<Record<Severity, number>> {
  const counts: Partial<Record<Severity, number>> = {};
  for (const item of generated) {
    if (item.duplicate) continue;
    const severity = item.comment.severity;
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  return counts;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(__PKG_VERSION__);
    return;
  }

  process.stderr.write(`[gitlab-review] ${__PKG_NAME__} v${__PKG_VERSION__}\n`);
  assertNodeVersion();
  // Expose any GITLAB_REVIEW_<NAME> provider/infra vars as <NAME> before
  // resolving config: getEnvApiKey and pi-ai's request-time reads both read
  // process.env directly, so this must mutate the live env first.
  applyGitLabReviewEnvPrefix();
  const config = resolveConfig(argv);
  const otel = await startOtelBridge();
  try {
    await run(config, { otel: otel ?? undefined });
  } finally {
    await otel?.shutdown();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}
