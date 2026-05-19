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
  | 'reviewer.run'
  | 'review.parse'
  | 'gitlab.get_discussions'
  | 'comments.build'
  | 'artifact.write_output'
  | 'gitlab.post_comments';

export interface DiagnosticError {
  name?: string;
  message: string;
  code?: string;
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
  errorInfo?: DiagnosticError;
}

export const DIAGNOSTIC_CHANNEL_PREFIX = '@ikko-dev/gitlab-review';

export const DIAGNOSTIC_CHANNEL_NAMES = {
  run: `${DIAGNOSTIC_CHANNEL_PREFIX}:run`,
  getMergeRequest: `${DIAGNOSTIC_CHANNEL_PREFIX}:gitlab.get_merge_request`,
  getLatestVersion: `${DIAGNOSTIC_CHANNEL_PREFIX}:gitlab.get_latest_version`,
  prepareGitHistory: `${DIAGNOSTIC_CHANNEL_PREFIX}:git.prepare_history`,
  getMergeDiff: `${DIAGNOSTIC_CHANNEL_PREFIX}:git.get_merge_diff`,
  runReviewer: `${DIAGNOSTIC_CHANNEL_PREFIX}:reviewer.run`,
  parseReview: `${DIAGNOSTIC_CHANNEL_PREFIX}:review.parse`,
  getDiscussions: `${DIAGNOSTIC_CHANNEL_PREFIX}:gitlab.get_discussions`,
  buildComments: `${DIAGNOSTIC_CHANNEL_PREFIX}:comments.build`,
  writeOutput: `${DIAGNOSTIC_CHANNEL_PREFIX}:artifact.write_output`,
  postComments: `${DIAGNOSTIC_CHANNEL_PREFIX}:gitlab.post_comments`,
} as const;

export const diagnosticChannels = {
  run: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.run),
  getMergeRequest: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.getMergeRequest),
  getLatestVersion: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.getLatestVersion),
  prepareGitHistory: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.prepareGitHistory),
  getMergeDiff: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.getMergeDiff),
  runReviewer: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.runReviewer),
  parseReview: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.parseReview),
  getDiscussions: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.getDiscussions),
  buildComments: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.buildComments),
  writeOutput: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.writeOutput),
  postComments: tracingChannel<DiagnosticContext>(DIAGNOSTIC_CHANNEL_NAMES.postComments),
} as const;

const channelsByPhase: Record<DiagnosticPhase, TracingChannel<DiagnosticContext>> = {
  run: diagnosticChannels.run,
  'gitlab.get_merge_request': diagnosticChannels.getMergeRequest,
  'gitlab.get_latest_version': diagnosticChannels.getLatestVersion,
  'git.prepare_history': diagnosticChannels.prepareGitHistory,
  'git.get_merge_diff': diagnosticChannels.getMergeDiff,
  'reviewer.run': diagnosticChannels.runReviewer,
  'review.parse': diagnosticChannels.parseReview,
  'gitlab.get_discussions': diagnosticChannels.getDiscussions,
  'comments.build': diagnosticChannels.buildComments,
  'artifact.write_output': diagnosticChannels.writeOutput,
  'gitlab.post_comments': diagnosticChannels.postComments,
};

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
  return traceDiagnostic(channelsByPhase[phase], context, operation);
}

function toDiagnosticError(error: unknown): DiagnosticError {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    return { name: error.name, message: error.message, code };
  }
  return { message: String(error) };
}
