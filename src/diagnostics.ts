import { randomUUID } from 'node:crypto';
import { tracingChannel, type TracingChannel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import type { Config } from './config.js';
import type { Severity } from './types.js';

export type DiagnosticPhase =
  | 'run'
  | 'gitlab.get_merge_request'
  | 'gitlab.get_latest_version'
  | 'git.prepare_history'
  | 'git.get_merge_diff'
  | 'git.get_commit_log'
  | 'reviewer.run'
  | 'review.parse'
  | 'gitlab.get_discussions'
  | 'comments.build'
  | 'artifact.write_output'
  | 'gitlab.post_comments'
  | 'gitlab.upsert_summary';

export interface DiagnosticError {
  name?: string;
  message: string;
  code?: string;
  /** True when the failure was a deadline/abort, so the bridge can label it `timeout`. */
  timeout?: boolean;
}

const CENSOR = '[REDACTED]';
/** Values shorter than this are not treated as secrets (avoids masking noise). */
const MIN_SECRET_SIZE = 6;

/**
 * The encodings a secret value might appear under in a free-form error message,
 * mirroring the transforms in `@zapier/secret-scrubber` so a token is caught
 * whether it was logged raw, URL-encoded, form-encoded, JSON-escaped, or base64.
 */
function secretVariants(value: string): string[] {
  return [
    value,
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%20/g, '+'),
    JSON.stringify(value).slice(1, -1), // JSON escaping, without the wrapping quotes
    Buffer.from(value, 'utf8').toString('base64'),
  ];
}

/**
 * Value-based secret redaction: removes the *known* secret values this run holds
 * (the GitLab token and the provider API key) from a string, in every encoding
 * they might appear under. Unlike pattern matching it cannot over-redact ordinary
 * text, cannot miss a token because of its format, and uses literal replacement
 * (no regex), so there is no catastrophic-backtracking risk on large messages.
 */
export function scrubSecrets(input: string, secretValues: readonly string[]): string {
  const variants = new Set<string>();
  for (const value of secretValues) {
    if (value.length < MIN_SECRET_SIZE) continue;
    for (const variant of secretVariants(value)) {
      if (variant.length >= MIN_SECRET_SIZE) variants.add(variant);
    }
  }
  // Replace longer variants first so a shorter one cannot pre-empt a longer match.
  const ordered = [...variants].toSorted((a, b) => b.length - a.length || (a < b ? 1 : -1));
  let result = input;
  for (const variant of ordered) result = result.split(variant).join(CENSOR);
  return result;
}

/** Collects the run's secret values (non-empty) for {@link scrubSecrets}. */
export function collectSecrets(config: Config): string[] {
  return [config.gitlabToken, config.apiKey].filter((value) => value.length > 0);
}

export interface DiagnosticUsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface DiagnosticUsage {
  model: string;
  tokens: DiagnosticUsageBreakdown;
  cost: DiagnosticUsageBreakdown;
}

export interface DiagnosticContext {
  version: 1;
  runId: string;
  phase: DiagnosticPhase;
  project: string;
  mr: string;
  gitlabUrl: string;
  cwd: string;
  model: string;
  minSeverity: string;
  dryRun: boolean;
  noPost: boolean;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  generated?: number;
  newComments?: number;
  duplicateComments?: number;
  posted?: number;
  /**
   * Breakdown of posted comments by severity, populated on the `run` context so
   * the OTel bridge can split `gitlab_review_comments_total` by severity. Counts
   * the non-duplicate (posted-intent) comments; absent on dry-run/skip paths.
   */
  postedBySeverity?: Partial<Record<Severity, number>>;
  warnings?: number;
  reviewFile?: string;
  output?: string;
  /** Number of files in the merge diff (set on the `git.get_merge_diff` phase). */
  diffFilesChanged?: number;
  /** Added content lines in the merge diff. */
  diffLinesAdded?: number;
  /** Removed content lines in the merge diff. */
  diffLinesRemoved?: number;
  /** HTTP method of the GitLab API call traced by this phase. */
  httpRequestMethod?: string;
  /** Full URL of the (last) GitLab API request in this phase; carries no secrets. */
  httpUrl?: string;
  /** HTTP status code of the (last) GitLab API response in this phase. */
  httpStatusCode?: number;
  /** Response Content-Length in bytes, when present. */
  httpResponseBodySize?: number;
  /** Host of the GitLab server the request targeted. */
  serverAddress?: string;
  draftsAbandoned?: number;
  draftsCreated?: number;
  draftsDeletedPrePublish?: number;
  draftsPublished?: number;
  summaryAction?: 'created' | 'updated' | 'skipped';
  summaryNoteId?: number;
  usage?: DiagnosticUsage;
  errorInfo?: DiagnosticError;
}

export const DIAGNOSTIC_CHANNEL_PREFIX = '@ikko-dev/gitlab-review';

export const DIAGNOSTIC_CHANNEL_NAMES = {
  run: `${DIAGNOSTIC_CHANNEL_PREFIX}:run`,
  getMergeRequest: `${DIAGNOSTIC_CHANNEL_PREFIX}:gitlab.get_merge_request`,
  getLatestVersion: `${DIAGNOSTIC_CHANNEL_PREFIX}:gitlab.get_latest_version`,
  prepareGitHistory: `${DIAGNOSTIC_CHANNEL_PREFIX}:git.prepare_history`,
  getMergeDiff: `${DIAGNOSTIC_CHANNEL_PREFIX}:git.get_merge_diff`,
  getCommitLog: `${DIAGNOSTIC_CHANNEL_PREFIX}:git.get_commit_log`,
  runReviewer: `${DIAGNOSTIC_CHANNEL_PREFIX}:reviewer.run`,
  parseReview: `${DIAGNOSTIC_CHANNEL_PREFIX}:review.parse`,
  getDiscussions: `${DIAGNOSTIC_CHANNEL_PREFIX}:gitlab.get_discussions`,
  buildComments: `${DIAGNOSTIC_CHANNEL_PREFIX}:comments.build`,
  writeOutput: `${DIAGNOSTIC_CHANNEL_PREFIX}:artifact.write_output`,
  postComments: `${DIAGNOSTIC_CHANNEL_PREFIX}:gitlab.post_comments`,
  upsertSummary: `${DIAGNOSTIC_CHANNEL_PREFIX}:gitlab.upsert_summary`,
} as const;

export const diagnosticChannels = Object.fromEntries(
  Object.entries(DIAGNOSTIC_CHANNEL_NAMES).map(([key, name]) => [
    key,
    tracingChannel<DiagnosticContext>(name),
  ]),
) as Record<
  keyof typeof DIAGNOSTIC_CHANNEL_NAMES,
  ReturnType<typeof tracingChannel<DiagnosticContext>>
>;

export function createDiagnosticRunId(): string {
  return randomUUID();
}

export function createDiagnosticContext(
  phase: DiagnosticPhase,
  config: Config,
  runId: string,
  overrides: Partial<DiagnosticContext> = {},
): DiagnosticContext {
  return {
    version: 1,
    runId,
    phase,
    project: config.project,
    mr: config.mr,
    gitlabUrl: config.gitlabUrl,
    cwd: config.cwd,
    model: config.model,
    minSeverity: config.minSeverity,
    dryRun: config.dryRun,
    noPost: config.noPost,
    reviewFile: config.reviewFile,
    output: config.output,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

export async function traceDiagnostic<T>(
  channel: TracingChannel<DiagnosticContext>,
  context: DiagnosticContext,
  operation: (context: DiagnosticContext) => Promise<T>,
  secretValues: readonly string[] = [],
): Promise<T> {
  const started = performance.now();

  return channel.tracePromise(async () => {
    try {
      return await operation(context);
    } catch (error) {
      context.errorInfo = toDiagnosticError(error, secretValues);
      throw error;
    } finally {
      context.completedAt = new Date().toISOString();
      context.durationMs = Number((performance.now() - started).toFixed(3));
    }
  }, context);
}

export function traceDiagnosticPhase<T>(
  phase: DiagnosticPhase,
  config: Config,
  runId: string,
  operation: (context: DiagnosticContext) => Promise<T>,
  overrides: Partial<DiagnosticContext> = {},
): Promise<T> {
  const context = createDiagnosticContext(phase, config, runId, overrides);
  // The phase string is exactly the channel-name suffix, so the tracing channel
  // is derived directly rather than kept in a parallel phase→channel table. The
  // tracing sub-channels are process-wide singletons keyed by name, so this
  // publishes to the same channels `diagnosticChannels` exposes for subscription
  // (e.g. the OTel bridge).
  return traceDiagnostic(
    tracingChannel<DiagnosticContext>(`${DIAGNOSTIC_CHANNEL_PREFIX}:${phase}`),
    context,
    operation,
    collectSecrets(config),
  );
}

function toDiagnosticError(error: unknown, secretValues: readonly string[] = []): DiagnosticError {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const timeout =
      'timeout' in error && (error as { timeout?: unknown }).timeout === true ? true : undefined;
    return { name: error.name, message: scrubSecrets(error.message, secretValues), code, timeout };
  }
  return { message: scrubSecrets(String(error), secretValues) };
}
