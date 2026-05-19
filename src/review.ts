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
export type {
  OtelApi,
  OtelBridge,
  OtelBridgeOptions,
  OtelRuntime,
  OtelSpan,
  OtelTracer,
} from './otel.js';
export { isOtelEnabled, startOtelBridge } from './otel.js';
export type {
  DiffRefs,
  Fingerprints,
  GeneratedComment,
  GitLabDiscussionPayload,
  ReviewComment,
  Side,
} from './types.js';
export { normalizeSeverity, toPiReviewerSeverity } from './types.js';
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
