import { randomUUID } from 'node:crypto';
import { tracingChannel, type TracingChannel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import type { Config } from './config.js';

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
  warnings?: number;
  reviewFile?: string;
  output?: string;
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

export const diagnosticChannels = {
  run: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.run),
  getMergeRequest: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.getMergeRequest),
  getLatestVersion: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.getLatestVersion),
  prepareGitHistory: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.prepareGitHistory),
  getMergeDiff: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.getMergeDiff),
  getCommitLog: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.getCommitLog),
  runReviewer: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.runReviewer),
  parseReview: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.parseReview),
  getDiscussions: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.getDiscussions),
  buildComments: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.buildComments),
  writeOutput: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.writeOutput),
  postComments: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.postComments),
  upsertSummary: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.upsertSummary),
} as const;

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
): Promise<T> {
  const started = performance.now();

  return channel.tracePromise(async () => {
    try {
      return await operation(context);
    } catch (error) {
      context.errorInfo = toDiagnosticError(error);
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
  );
}

function toDiagnosticError(error: unknown): DiagnosticError {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    return { name: error.name, message: error.message, code };
  }
  return { message: String(error) };
}
