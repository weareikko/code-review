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
export type { SigilBridge, SigilBridgeOptions } from './sigil.js';
export { isSigilEnabled, startSigilBridge } from './sigil.js';
export type { RunBridges, RunResult } from './cli.js';
export { run } from './cli.js';
export type {
  AgentLike,
  CreateAgent,
  CreateAgentParams,
  ReviewUsage,
  RunReviewOptions,
  UsageBreakdown,
} from './gitlab-review.js';
export { runReview } from './gitlab-review.js';
export type {
  DiffRefs,
  Fingerprints,
  GeneratedComment,
  GitLabDiscussionPayload,
  ReviewComment,
  Side,
} from './types.js';
export { normalizeSeverity, toGitLabReviewSeverity } from './types.js';
export {
  parseReviewMarkdown,
  parseReviewMarkdownWithWarnings,
  type ParseResult,
} from './parser.js';
export {
  appendFingerprintMarkers,
  extractDiffHunkContext,
  extractExistingFingerprints,
  fingerprints,
  normalizeBody,
  sha256,
} from './fingerprints.js';
export { buildGeneratedComments, buildPayload } from './payloads.js';
export {
  SUMMARY_HISTORY_END,
  SUMMARY_HISTORY_ENTRY_END,
  SUMMARY_HISTORY_ENTRY_START,
  SUMMARY_HISTORY_LIMIT,
  SUMMARY_HISTORY_START,
  SUMMARY_MARKER,
  buildArchivedSummaryEntry,
  buildSummaryBody,
  buildReviewedCommitFooter,
  buildSummaryHistoryEntries,
  extractReviewedCommitSha,
  extractSummaryHistoryEntries,
  findExistingReviewedCommitSha,
  findExistingSummaryNote,
  findExistingSummaryNoteId,
  stripSummaryHistory,
  stripSummaryMarker,
  upsertSummaryNote,
  type SummaryAction,
  type SummaryBodyOptions,
  type SummaryNote,
  type SummaryResult,
  type UpsertSummaryOptions,
} from './posting.js';
