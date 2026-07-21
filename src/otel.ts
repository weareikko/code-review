/**
 * Optional OpenTelemetry bridge over `diagnostics_channel` and the agent
 * event stream.
 *
 * Subscribes to every `@weareikko/code-review:*` tracing channel, opens an
 * OTel span on `start`, and closes it on `asyncEnd`/`error`. The `reviewer.run`
 * phase additionally carries OpenTelemetry GenAI semantic-convention
 * attributes (`gen_ai.*`) and emits the standardized GenAI client metrics
 * (`gen_ai.client.operation.duration`, `gen_ai.client.token.usage`,
 * `code_review_llm_cost_usd`, `gen_ai.client.operation.time_to_first_chunk`) so
 * metrics-driven AI observability surfaces auto-discover the service.
 *
 * Per-turn and per-tool-call telemetry is captured via `createAgentTelemetry`,
 * which subscribes to the agent's live event stream and emits:
 *   - `gen_ai.agent.turn` child spans under `invoke_agent code-review`
 *   - `execute_tool <name>` grandchild spans under each turn
 *   - Per-turn `gen_ai.client.token.usage` and `code_review_llm_cost_usd` metrics
 *   - `gen_ai.client.operation.time_to_first_chunk` when streaming events fire
 *
 * Opt-in: set `CODE_REVIEW_OTEL=1`. Exporter selection and endpoint follow
 * the standard `OTEL_*` env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, …).
 *
 * **Content capture**: set `CODE_REVIEW_OTEL_CAPTURE_CONTENT=1` to attach
 * LLM output text and tool arguments/results to spans as `gen_ai.output.messages`,
 * `gen_ai.tool.call.arguments`, and `gen_ai.tool.call.result`. These attributes
 * may contain code diffs and review commentary — only enable after confirming
 * your observability backend's data-retention and PII policies allow it.
 *
 * **Grafana Cloud token scopes**: for all three signals to reach their
 * respective backends, the service account token used in
 * `OTEL_EXPORTER_OTLP_HEADERS` must have:
 *   - `Traces Publisher` — writes to Tempo (traces)
 *   - `Metrics Publisher` — writes to Mimir (gen_ai.* histograms)
 *   - `Logs Publisher` — writes to Loki (structured log records)
 * A token missing any of these scopes will receive `401 Unauthorized:
 * invalid scope requested` silently from the OTLP gateway. Enable OTel
 * diagnostics with `OTEL_LOG_LEVEL=error` to surface export failures.
 *
 * The OTel SDK runtime is bundled but loaded via dynamic `import()` behind the
 * env check, so disabling the bridge skips the SDK boot entirely. Library
 * callers who already have configured providers in their process can inject
 * their own runtime via `startOtelBridge({ runtime })` so spans and metrics
 * join the host providers instead of a second `NodeSDK`.
 */

import type {
  Attributes,
  Context,
  Counter,
  Histogram,
  Meter,
  MeterProvider,
  Span,
  Tracer,
  TracerProvider,
} from '@opentelemetry/api';
import { context, metrics, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Logger, LoggerProvider } from '@opentelemetry/api-logs';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
  diagnosticChannels,
  type DiagnosticContext,
  type DiagnosticPhase,
  type DiagnosticUsage,
} from './diagnostics.js';
import type { AgentLike } from './gitlab-review.js';
import { splitModel, type GeneratedComment } from './types.js';

// Inlined at build time by Vite's `define` (see vite.config.ts). Keeps
// `service.version` accurate under `npx`/standalone bin invocations, where
// `npm_package_version` from `npm run` is not set.
declare const __PKG_VERSION__: string;

export interface OtelBridge {
  shutdown(): Promise<void>;
  /**
   * Returns a function that, when called with an agent, subscribes to its live
   * event stream and emits per-turn and per-tool-call OTel spans/metrics.
   * Must be called after the `reviewer.run` diagnostic span is open (i.e. from
   * inside `traceDiagnosticPhase('reviewer.run', ...)`). Returns `undefined`
   * when the span is not yet open or OTel is disabled.
   */
  createAgentTelemetry(runId: string): ((agent: AgentLike) => () => void) | undefined;
  /**
   * Emits one structured OTel log record per generated comment to Loki/the
   * configured log backend. Each record carries `event.name`,
   * `code_review.comment.*` attributes, and the comment body as the log
   * line. Safe to call at any point after the run phase has opened.
   */
  logComments(comments: GeneratedComment[], runId: string): void;
}

export interface OtelRuntime {
  tracerProvider: TracerProvider;
  meterProvider: MeterProvider;
  loggerProvider: LoggerProvider;
  shutdown(): Promise<void>;
}

export interface OtelBridgeOptions {
  /**
   * Pre-wired OTel runtime. When provided, the bridge uses the supplied
   * providers and skips dynamic import of `@opentelemetry/sdk-node`. Library
   * callers with configured `TracerProvider`/`MeterProvider` should pass their
   * own providers plus a no-op `shutdown`; tests inject fakes with assertion
   * hooks.
   */
  runtime?: OtelRuntime;
  /**
   * Override the env source used for the opt-in check. Defaults to
   * `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * When true, attaches LLM output text and tool call arguments/results to
   * spans as `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, and
   * `gen_ai.tool.call.result`. Defaults to `isContentCaptureEnabled(env)`.
   *
   * Only enable after confirming your observability backend's data-retention
   * and PII policies permit storing code review content.
   */
  captureContent?: boolean;
}

const ROOT_PHASE: DiagnosticPhase = 'run';
const GEN_AI_PHASE: DiagnosticPhase = 'reviewer.run';
const POST_COMMENTS_PHASE: DiagnosticPhase = 'scm.post_comments';
const SERVICE_NAME = '@weareikko/code-review';

// Added as a data-point attribute on every code_review_* metric so that
// Prometheus/Mimir surfaces it as a label (service_name="…"). The SDK-level
// service.name resource attribute only populates target_info, not per-metric
// labels, so we need to include it explicitly here.
const REVIEW_SERVICE_ATTRS = { 'service.name': SERVICE_NAME } as const;

// Advisory histogram bucket boundaries from the OTel GenAI metrics semconv.
// https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
const DURATION_BUCKETS_S = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];
const TOKEN_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];
const TTFT_BUCKETS_S = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
];
const COST_BUCKETS_USD = [
  0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
];
// Review-level histogram boundaries — one observation per complete run or per phase.
const REVIEW_RUN_DURATION_BUCKETS_S = [5, 15, 30, 60, 120, 180, 300, 600];
const REVIEW_TOTAL_COST_BUCKETS_USD = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];
const REVIEW_PHASE_DURATION_BUCKETS_S = [1, 5, 15, 30, 60, 120, 300];

const OTEL_SDK_PACKAGES = [
  '@opentelemetry/sdk-node',
  '@opentelemetry/resources',
  '@opentelemetry/semantic-conventions',
] as const;

const noop = (): void => undefined;

interface OpenSpan {
  span: Span;
  closed: boolean;
}

// Minimal shape of a per-turn assistant message we need for telemetry.
// Avoids importing AssistantMessage from @earendil-works/pi-ai in this module.
interface TurnMessage {
  role?: string;
  model?: string;
  stopReason?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
}

export function isOtelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_REVIEW_OTEL === '1' || env.CODE_REVIEW_OTEL === 'true';
}

/**
 * Returns true when `CODE_REVIEW_OTEL_CAPTURE_CONTENT=1` (or `true`) is set.
 *
 * When enabled, per-turn assistant output text is attached to turn spans as
 * `gen_ai.output.messages`, and tool arguments / results are attached to
 * `execute_tool` spans as `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result`.
 *
 * These fields may contain code diffs and review commentary — only enable after
 * confirming your observability backend's data-retention and PII policies.
 */
export function isContentCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.CODE_REVIEW_OTEL_CAPTURE_CONTENT === '1' || env.CODE_REVIEW_OTEL_CAPTURE_CONTENT === 'true'
  );
}

export async function startOtelBridge(options: OtelBridgeOptions = {}): Promise<OtelBridge | null> {
  const env = options.env ?? process.env;
  if (!isOtelEnabled(env)) return null;

  const captureContent = options.captureContent ?? isContentCaptureEnabled(env);
  const ciAttrs = buildCiAttrs(env);
  const ciSpanAttrs = buildCiSpanAttrs(env);

  const runtime = options.runtime ?? (await loadDefaultRuntime());
  const tracer: Tracer = runtime.tracerProvider.getTracer(SERVICE_NAME);
  const meter: Meter = runtime.meterProvider.getMeter(SERVICE_NAME);
  const logger: Logger = runtime.loggerProvider.getLogger(SERVICE_NAME);

  const operationDuration = meter.createHistogram('gen_ai.client.operation.duration', {
    description: 'GenAI operation duration',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_S },
  });
  const tokenUsage = meter.createHistogram('gen_ai.client.token.usage', {
    description: 'Measures number of input and output tokens used',
    unit: '{token}',
    advice: { explicitBucketBoundaries: TOKEN_BUCKETS },
  });
  // Per-turn LLM cost in USD, broken down by token type. Cost is NOT part of the
  // OTel GenAI conventions (no gen_ai.* cost metric or attribute exists), so this
  // is a deliberate local extension kept out of the reserved `gen_ai.*` namespace
  // to avoid colliding if the spec later standardizes cost.
  const operationCost = meter.createHistogram('code_review_llm_cost_usd', {
    description: 'LLM cost in USD per turn, by token type (non-standard extension)',
    unit: '{usd}',
    advice: { explicitBucketBoundaries: COST_BUCKETS_USD },
  });
  // GenAI-semconv client streaming metric. The client-side name is
  // `operation.time_to_first_chunk`; `time_to_first_token` exists only server-side.
  const timeToFirstToken = meter.createHistogram('gen_ai.client.operation.time_to_first_chunk', {
    description: 'Time to first chunk from the LLM',
    unit: 's',
    advice: { explicitBucketBoundaries: TTFT_BUCKETS_S },
  });

  // Review-level metrics — one observation per complete run or per phase.
  const {
    reviewRunDuration,
    reviewTotalCost,
    reviewCommentsTotal,
    reviewDraftsPublishedTotal,
    reviewPhaseDuration,
    reviewRunsTotal,
    reviewErrorsTotal,
    reviewLlmTokens,
  } = createReviewInstruments(meter);

  const openByRun = new Map<string, Map<DiagnosticPhase, OpenSpan>>();

  // Per-run metadata cached from the ROOT_PHASE context for use in the review
  // completion log, per-turn agent telemetry (configuredModel), and logComments.
  const runMeta = new Map<string, RunMeta>();

  const parentContext = (runId: string) => {
    const root = openByRun.get(runId)?.get(ROOT_PHASE);
    return root && !root.closed ? trace.setSpan(context.active(), root.span) : context.active();
  };

  const openSpan = (ctx: DiagnosticContext): void => {
    let phases = openByRun.get(ctx.runId);
    if (!phases) {
      phases = new Map();
      openByRun.set(ctx.runId, phases);
    }
    // A still-open span for this phase means a duplicate start — ignore it. A
    // *closed* entry means the phase legitimately runs more than once per run
    // (e.g. scm.get_discussions, fetched before and after the review); let it
    // re-open so the second occurrence gets its own span and HTTP attributes.
    const existing = phases.get(ctx.phase);
    if (existing && !existing.closed) return;
    const span = tracer.startSpan(
      spanNameFor(ctx.phase),
      {
        kind: SpanKind.INTERNAL,
        attributes: { ...baseAttributes(ctx), ...ciAttrs, ...ciSpanAttrs },
      },
      parentContext(ctx.runId),
    );
    phases.set(ctx.phase, { span, closed: false });
    // Seed run metadata for logComments, completion log, and per-turn agent
    // telemetry (model feeds gen_ai.system derivation in buildAgentSubscriber).
    if (ctx.phase === ROOT_PHASE) {
      // Store root span context so logger.emit() can correlate log records to
      // the trace — tracer.startSpan does not activate the span, so we capture
      // the context explicitly here while the span is live.
      const rootSpanCtx = trace.setSpan(context.active(), span);
      runMeta.set(ctx.runId, {
        project: ctx.project,
        mr: ctx.mr,
        gitlabUrl: ctx.gitlabUrl,
        ciAttrs,
        ciSpanAttrs,
        model: ctx.model,
        dryRun: ctx.dryRun,
        rootSpanCtx,
      });
      // Emit a run-start log so log-only consumers can compute duration and
      // detect stuck/hung runs without waiting for (or ever seeing) a completion.
      emitReviewStartedLog(logger, ctx, ciAttrs, ciSpanAttrs, rootSpanCtx);
    }
  };

  const closeSpan = (ctx: DiagnosticContext, isError: boolean): void => {
    const entry = openByRun.get(ctx.runId)?.get(ctx.phase);
    if (!entry || entry.closed) return;
    if (ctx.phase === GEN_AI_PHASE) {
      applyGenAiAttributes(entry.span, ctx);
      recordGenAiMetrics(operationDuration, ctx, isError, ciAttrs);
      // Cache usage so the ROOT_PHASE completion log can include cost/token totals.
      if (ctx.usage) {
        const meta = runMeta.get(ctx.runId);
        if (meta) meta.usage = ctx.usage;
      }
    }
    // Cache posting results from the post_comments phase so they are available when
    // the root phase closes and emits the review-level drafts metric.
    if (ctx.phase === POST_COMMENTS_PHASE && typeof ctx.draftsPublished === 'number') {
      const meta = runMeta.get(ctx.runId);
      if (meta) meta.draftsPublished = ctx.draftsPublished;
    }
    applyResultAttributes(entry.span, ctx);
    if (isError && ctx.errorInfo) {
      entry.span.recordException(ctx.errorInfo);
      entry.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: ctx.errorInfo.message,
      });
    }
    entry.span.end();
    entry.closed = true;

    const status = resolveRunStatus(ctx, isError);
    const projectPath = ciAttrs['vcs.repository.name'] ?? '';

    // Emit a phase-duration observation for every phase that has a measured duration.
    if (typeof ctx.durationMs === 'number') {
      reviewPhaseDuration.record(ctx.durationMs / 1000, {
        ...REVIEW_SERVICE_ATTRS,
        'vcs.repository.name': projectPath,
        'code_review.phase': ctx.phase,
        'code_review.status': status,
      });
    }

    if (ctx.phase === ROOT_PHASE) {
      const meta = runMeta.get(ctx.runId);
      const pipelineSource = ciAttrs['cicd.pipeline.source'] ?? '';
      // Shared label set for every review-level metric data point.
      const runMetricBase = {
        ...REVIEW_SERVICE_ATTRS,
        'vcs.repository.name': projectPath,
        'code_review.dry_run': ctx.dryRun,
      };
      const usage = meta?.usage ?? ctx.usage;
      // gen_ai.request.model lets cost/duration/token series be compared across
      // model versions. It is low-cardinality (changes only when the configured
      // model changes), unlike run_id which we keep off metrics entirely.
      const runModelAttrs = genAiModelAttrs(undefined, splitModel(usage?.model ?? '').modelId);

      // One increment per run regardless of duration availability. This is the
      // canonical "how many reviews ran" series; counting histogram `_count`
      // proved unreliable for the dashboard, and run_id is deliberately NOT a
      // label here — a per-run UUID would explode Prometheus/Mimir cardinality.
      reviewRunsTotal.add(1, {
        ...runMetricBase,
        'cicd.pipeline.source': pipelineSource,
        'code_review.status': status,
      });

      // Dedicated error counter so an error rate can be alerted on without
      // decomposing the runs_total series. error.type mirrors the convention
      // used for the gen_ai duration metric (typed-error code, else name).
      if (isError) {
        reviewErrorsTotal.add(1, {
          ...runMetricBase,
          'code_review.status': status,
          'error.type': errorTypeOf(ctx),
        });
      }

      if (typeof ctx.durationMs === 'number') {
        reviewRunDuration.record(ctx.durationMs / 1000, {
          ...runMetricBase,
          ...runModelAttrs,
          'cicd.pipeline.source': pipelineSource,
          'code_review.status': status,
        });
      }

      const totalCostUsd = usage?.cost.total;
      if (totalCostUsd !== undefined) {
        reviewTotalCost.record(totalCostUsd, {
          ...runMetricBase,
          ...runModelAttrs,
          'code_review.status': status,
        });
      }

      // LLM token consumption as cumulative counters (one per token type), so
      // token trends can be alerted on and dashboarded with rate()/increase()
      // without summing the per-turn gen_ai.client.token.usage histogram.
      if (usage) {
        const tokenAttrs = {
          ...REVIEW_SERVICE_ATTRS,
          ...runModelAttrs,
          'vcs.repository.name': projectPath,
        };
        const tokenByType = [
          ['input', 'input'],
          ['output', 'output'],
          ['cacheRead', 'cache_read'],
          ['cacheWrite', 'cache_creation'],
        ] as const;
        for (const [field, type] of tokenByType) {
          const value = usage.tokens[field];
          if (value > 0) reviewLlmTokens[type].add(value, tokenAttrs);
        }
      }

      // Prefer a per-severity breakdown (matching the code_review.comment.severity
      // log attribute) when the run provided one; fall back to a single
      // unlabelled increment for callers/contexts that only know the total.
      const bySeverity = ctx.postedBySeverity;
      if (bySeverity) {
        for (const [severity, count] of Object.entries(bySeverity)) {
          if (count && count > 0) {
            reviewCommentsTotal.add(count, {
              ...runMetricBase,
              'code_review.comment.severity': severity,
            });
          }
        }
      } else {
        const posted = ctx.posted ?? 0;
        if (posted > 0) reviewCommentsTotal.add(posted, runMetricBase);
      }

      reviewDraftsPublishedTotal.add(meta?.draftsPublished ?? 0, runMetricBase);

      emitReviewCompletedLog(logger, ctx, meta, isError);
      runMeta.delete(ctx.runId);
      openByRun.delete(ctx.runId);
    }
  };

  const handlers = {
    start: (ctx: DiagnosticContext) => openSpan(ctx),
    end: noop,
    asyncStart: noop,
    asyncEnd: (ctx: DiagnosticContext) => closeSpan(ctx, false),
    error: (ctx: DiagnosticContext) => closeSpan(ctx, true),
  };

  const unsubs: Array<() => void> = [];
  for (const channel of Object.values(diagnosticChannels)) {
    channel.subscribe(handlers);
    unsubs.push(() => channel.unsubscribe(handlers));
  }

  return {
    async shutdown() {
      for (const off of unsubs) off();
      for (const phases of openByRun.values()) {
        for (const entry of phases.values()) {
          if (!entry.closed) {
            entry.span.end();
            entry.closed = true;
          }
        }
      }
      openByRun.clear();
      runMeta.clear();
      await runtime.shutdown();
    },

    logComments(comments: GeneratedComment[], runId: string): void {
      const meta = runMeta.get(runId);
      for (const { comment, duplicate } of comments) {
        const preview = comment.body.length > 500 ? `${comment.body.slice(0, 497)}…` : comment.body;
        logger.emit({
          severityNumber: SeverityNumber.INFO,
          severityText: 'INFO',
          body: `[${comment.severity}] ${comment.file}:${comment.line} — ${preview}`,
          context: meta?.rootSpanCtx,
          attributes: {
            'service.name': SERVICE_NAME,
            'event.name': 'code_review.comment',
            'code_review.run_id': runId,
            'code_review.comment.file': comment.file,
            'code_review.comment.line': comment.line,
            'code_review.comment.severity': comment.severity,
            'code_review.comment.is_duplicate': duplicate,
            ...(meta && {
              'vcs.repository.id': meta.project,
              'vcs.change.id': meta.mr,
              'vcs.repository.url.full': meta.gitlabUrl,
              ...meta.ciAttrs,
              ...meta.ciSpanAttrs,
            }),
          },
        });
      }
    },

    createAgentTelemetry(runId: string): ((agent: AgentLike) => () => void) | undefined {
      const reviewerEntry = openByRun.get(runId)?.get(GEN_AI_PHASE);
      if (!reviewerEntry || reviewerEntry.closed) return undefined;
      const reviewerSpanCtx = trace.setSpan(context.active(), reviewerEntry.span);
      return buildAgentSubscriber(
        tracer,
        tokenUsage,
        operationCost,
        timeToFirstToken,
        reviewerSpanCtx,
        {
          ciAttrs,
          runId,
          // Pass the configured model so the per-turn subscriber can derive
          // gen_ai.system when msg.model carries a bare ID without a provider prefix.
          configuredModel: runMeta.get(runId)?.model,
          // Carry dry-run through so per-turn gen_ai.* metrics can be filtered
          // to exclude dry-run cost/tokens, matching the review-level metrics.
          dryRun: runMeta.get(runId)?.dryRun,
          captureContent,
        },
      );
    },
  };
}

interface AgentSubscriberOptions {
  ciAttrs?: Record<string, string>;
  runId?: string;
  /**
   * Full configured model string (e.g. `'anthropic/claude-sonnet-4-5'`). Used
   * as a fallback to derive `gen_ai.system` when the agent event stream emits
   * bare model IDs without a provider prefix (common with the Anthropic SDK).
   */
  configuredModel?: string;
  /**
   * Whether the enclosing review run is a dry run. When defined, emitted as the
   * `code_review.dry_run` label on every per-turn gen_ai.* metric so dry-run
   * cost/tokens can be excluded from the gen_ai panels.
   */
  dryRun?: boolean;
  /**
   * When true, serializes LLM output text and tool call arguments/results onto
   * spans as `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, and
   * `gen_ai.tool.call.result`. Requires explicit opt-in via
   * `CODE_REVIEW_OTEL_CAPTURE_CONTENT=1` or `OtelBridgeOptions.captureContent`.
   */
  captureContent?: boolean;
}

/**
 * Builds the dynamic `gen_ai.provider.name` / `gen_ai.request.model` metric
 * labels shared by the per-turn and per-phase GenAI metric emitters. Owning
 * these in one place keeps the two emission sites from drifting into separate
 * Prometheus series (the double-count `recordGenAiMetrics` documents).
 *
 * `gen_ai.provider.name` is the current GenAI-semconv discriminator; the
 * deprecated `gen_ai.system` is emitted alongside it during the transition so
 * backends still keyed on the old attribute keep working.
 */
function genAiModelAttrs(provider?: string, modelId?: string): Attributes {
  return {
    ...(provider ? { 'gen_ai.provider.name': provider, 'gen_ai.system': provider } : {}),
    ...(modelId ? { 'gen_ai.request.model': modelId } : {}),
  };
}

/**
 * Sets the shared `gen_ai.usage.*` token-count attributes on a span.
 *
 * gen_ai.usage.input_tokens follows Sentry AI monitoring's convention: the
 * value is the TOTAL tokens consumed as input (non-cached + cached).
 * gen_ai.usage.input_tokens.cached is the cached SUBSET so backends can compute
 * uncached cost without negative values (Sentry warns about this).
 * gen_ai.usage.cache_read.input_tokens is kept for Grafana backward compat.
 */
function setTokenUsageSpanAttributes(
  span: Span,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  span.setAttribute('gen_ai.usage.input_tokens', tokens.input + tokens.cacheRead);
  if (tokens.cacheRead) span.setAttribute('gen_ai.usage.input_tokens.cached', tokens.cacheRead);
  span.setAttribute('gen_ai.usage.output_tokens', tokens.output);
  if (tokens.cacheRead) span.setAttribute('gen_ai.usage.cache_read.input_tokens', tokens.cacheRead);
  if (tokens.cacheWrite) {
    span.setAttribute('gen_ai.usage.cache_creation.input_tokens', tokens.cacheWrite);
  }
}

/** Applies per-turn token counts and costs to the turn span and emits metric observations. */
function recordTurnUsage(
  span: Span,
  u: NonNullable<TurnMessage['usage']>,
  metricAttrs: Attributes,
  tokenUsage: Histogram,
  operationCost: Histogram,
): void {
  // Emit all four token type measurements per OTel GenAI semconv.
  // These are the canonical source for gen_ai.client.token.usage —
  // recordGenAiMetrics only emits phase duration to avoid double-count.
  tokenUsage.record(u.input, { ...metricAttrs, 'gen_ai.token.type': 'input' });
  tokenUsage.record(u.output, { ...metricAttrs, 'gen_ai.token.type': 'output' });
  if (u.cacheRead) {
    tokenUsage.record(u.cacheRead, { ...metricAttrs, 'gen_ai.token.type': 'cache_read' });
  }
  if (u.cacheWrite) {
    tokenUsage.record(u.cacheWrite, { ...metricAttrs, 'gen_ai.token.type': 'cache_creation' });
  }
  setTokenUsageSpanAttributes(span, u);
  if (u.cost) {
    // Emit cost broken down by token type (mirrors gen_ai.client.token.usage).
    // Per-turn is the sole emission point to prevent double-count.
    if (u.cost.input)
      operationCost.record(u.cost.input, { ...metricAttrs, 'gen_ai.token.type': 'input' });
    if (u.cost.output)
      operationCost.record(u.cost.output, { ...metricAttrs, 'gen_ai.token.type': 'output' });
    if (u.cost.cacheRead)
      operationCost.record(u.cost.cacheRead, {
        ...metricAttrs,
        'gen_ai.token.type': 'cache_read',
      });
    if (u.cost.cacheWrite)
      operationCost.record(u.cost.cacheWrite, {
        ...metricAttrs,
        'gen_ai.token.type': 'cache_creation',
      });
    span.setAttribute('code_review.cost.input_usd', u.cost.input);
    span.setAttribute('code_review.cost.output_usd', u.cost.output);
    span.setAttribute('code_review.cost.total_usd', u.cost.total);
  }
}

/**
 * Safely serializes a value to a JSON string for use as an OTel span attribute.
 * Truncates to `maxLen` characters to stay within typical span attribute limits.
 * Returns `undefined` when the value is `null` or `undefined`.
 */
function safeSerialize(value: unknown, maxLen = 2000): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort extraction of the command string from a tool call's start `args`.
 * Tool args are tool-defined; Bash-style tools expose `command`. Returns
 * `undefined` for tools without one (Read/Grep/Find/Ls), in which case
 * `tool.command` is simply not set.
 */
function extractToolCommand(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * Best-effort extraction of an exit code and stderr from a tool's error result.
 * The result is tool-defined (`any`); shell-backed tools follow the
 * `{ code, stderr }` ExecResult shape (also accepts `exitCode`). Missing fields
 * are left `undefined` so no misleading attribute is set.
 */
function extractToolErrorDetail(result: unknown): { exitCode?: number; stderr?: string } {
  if (typeof result !== 'object' || result === null) return {};
  const r = result as { exitCode?: unknown; code?: unknown; stderr?: unknown };
  const exitRaw = typeof r.exitCode === 'number' ? r.exitCode : r.code;
  return {
    exitCode: typeof exitRaw === 'number' ? exitRaw : undefined,
    stderr: typeof r.stderr === 'string' ? r.stderr : undefined,
  };
}

/**
 * Extracts printable text content from an assistant message's content array.
 * Returns a JSON-serialized array in Sentry's `{role, parts: [{type, text}]}` format,
 * or `undefined` when no text blocks are found.
 */
function extractOutputMessages(msg: TurnMessage): string | undefined {
  const content = (msg as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((block): block is { type: string; text: string } => {
      return (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: string }).text === 'string'
      );
    })
    .map((block) => ({ type: 'text', text: block.text }));
  if (texts.length === 0) return undefined;
  return safeSerialize([{ role: 'assistant', parts: texts }]);
}

function buildAgentSubscriber(
  tracer: Tracer,
  tokenUsage: Histogram,
  operationCost: Histogram,
  timeToFirstToken: Histogram,
  reviewerSpanCtx: ReturnType<typeof trace.setSpan>,
  options: AgentSubscriberOptions = {},
): (agent: AgentLike) => () => void {
  const { ciAttrs = {}, runId, configuredModel, dryRun, captureContent = false } = options;
  // configuredModel is fixed for the subscriber's lifetime, so derive its
  // provider once instead of re-splitting it on every turn (the common
  // Anthropic-SDK case where msg.model carries a bare ID without a provider).
  const configuredProvider = configuredModel ? splitModel(configuredModel).provider : undefined;
  // Static base for every per-turn GenAI metric; the dynamic gen_ai.system /
  // gen_ai.request.model labels are merged per message_end.
  const baseMetricAttrs: Attributes = {
    'gen_ai.operation.name': 'invoke_agent',
    ...REVIEW_SERVICE_ATTRS,
    ...ciAttrs,
    ...(dryRun !== undefined ? { 'code_review.dry_run': dryRun } : {}),
  };
  return (agent: AgentLike): (() => void) => {
    let currentTurn: { span: Span; startMs: number; firstTokenMs?: number } | undefined;
    // Track the originating command alongside the span so tool.command can be
    // attached on error (it lives on the start event's args, not the result).
    const openTools = new Map<string, { span: Span; command?: string }>();

    return agent.subscribe(async (event) => {
      const type = (event as { type?: string }).type;
      if (!type) return;

      if (type === 'turn_start') {
        if (currentTurn) currentTurn.span.end(); // close any orphaned turn
        const turnIndex = (event as { turnIndex?: number }).turnIndex;
        const span = tracer.startSpan(
          'gen_ai.agent.turn',
          { kind: SpanKind.INTERNAL },
          reviewerSpanCtx,
        );
        span.setAttribute('gen_ai.operation.name', 'invoke_agent');
        span.setAttribute('gen_ai.agent.name', 'code-review');
        if (runId) span.setAttribute('gen_ai.conversation.id', runId);
        if (typeof turnIndex === 'number') span.setAttribute('gen_ai.agent.turn.index', turnIndex);
        currentTurn = { span, startMs: Date.now() };
      }

      if (type === 'message_update' && currentTurn && !currentTurn.firstTokenMs) {
        currentTurn.firstTokenMs = Date.now();
      }

      if (type === 'message_end') {
        const msg = (event as { message?: TurnMessage }).message;
        if (!msg || msg.role !== 'assistant' || !currentTurn) return;
        const { span, startMs, firstTokenMs } = currentTurn;
        currentTurn = undefined;

        // Extract provider and model ID from msg.model. The Anthropic SDK may
        // emit bare IDs like 'claude-sonnet-4-5' without a provider prefix; in
        // that case fall back to the configured model's provider so all per-turn
        // metrics share a consistent label set.
        const parts = splitModel(String(msg.model ?? ''));
        const modelId = parts.modelId;
        const provider = parts.provider ?? configuredProvider;

        const metricAttrs: Attributes = {
          ...baseMetricAttrs,
          ...genAiModelAttrs(provider, modelId),
        };
        // Spans carry gen_ai.response.model (the SDK's actual model); metrics
        // carry gen_ai.request.model (set above via genAiModelAttrs).
        if (provider) {
          span.setAttribute('gen_ai.provider.name', provider);
          span.setAttribute('gen_ai.system', provider);
        }
        if (modelId) span.setAttribute('gen_ai.response.model', modelId);
        if (msg.stopReason) span.setAttribute('gen_ai.response.stop_reason', msg.stopReason);

        if (firstTokenMs !== undefined) {
          const ttftS = (firstTokenMs - startMs) / 1000;
          timeToFirstToken.record(ttftS, metricAttrs);
          span.setAttribute('gen_ai.client.operation.time_to_first_chunk_s', ttftS);
        }

        if (msg.usage) {
          recordTurnUsage(span, msg.usage, metricAttrs, tokenUsage, operationCost);
        }

        // Optional content capture — requires CODE_REVIEW_OTEL_CAPTURE_CONTENT=1.
        if (captureContent) {
          const outputMsgs = extractOutputMessages(msg);
          if (outputMsgs) span.setAttribute('gen_ai.output.messages', outputMsgs);
        }

        span.end();
      }

      if (type === 'tool_execution_start') {
        const { toolName, toolCallId, args } = event as {
          toolName?: string;
          toolCallId?: string;
          args?: unknown;
        };
        if (!toolName || !toolCallId) return;
        const toolParentCtx = currentTurn
          ? trace.setSpan(context.active(), currentTurn.span)
          : reviewerSpanCtx;
        const toolSpan = tracer.startSpan(
          `execute_tool ${toolName}`,
          { kind: SpanKind.INTERNAL },
          toolParentCtx,
        );
        toolSpan.setAttribute('gen_ai.operation.name', 'execute_tool');
        toolSpan.setAttribute('gen_ai.tool.name', toolName);
        toolSpan.setAttribute('gen_ai.tool.call.id', toolCallId);
        if (captureContent && args !== undefined) {
          const argsStr = safeSerialize(args);
          if (argsStr) toolSpan.setAttribute('gen_ai.tool.call.arguments', argsStr);
        }
        openTools.set(toolCallId, { span: toolSpan, command: extractToolCommand(args) });
      }

      if (type === 'tool_execution_end') {
        const { toolCallId, isError, result } = event as {
          toolCallId?: string;
          isError?: boolean;
          result?: unknown;
        };
        if (!toolCallId) return;
        const entry = openTools.get(toolCallId);
        if (!entry) return;
        const { span, command } = entry;
        if (isError) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          // Enrich the failure so a span isn't just "Unknown error". exit_code is
          // a safe scalar; stderr/command can contain code, so gate them behind
          // the same content-capture opt-in as tool arguments/results.
          const { exitCode, stderr } = extractToolErrorDetail(result);
          if (exitCode !== undefined) span.setAttribute('process.exit_code', exitCode);
          if (captureContent) {
            const stderrStr = stderr !== undefined ? safeSerialize(stderr) : undefined;
            if (stderrStr) span.setAttribute('tool.stderr', stderrStr);
            const commandStr = command !== undefined ? safeSerialize(command) : undefined;
            if (commandStr) span.setAttribute('tool.command', commandStr);
          }
        }
        if (captureContent && result !== undefined) {
          const resultStr = safeSerialize(result);
          if (resultStr) span.setAttribute('gen_ai.tool.call.result', resultStr);
        }
        span.end();
        openTools.delete(toolCallId);
      }

      if (type === 'agent_end') {
        if (currentTurn) {
          currentTurn.span.end();
          currentTurn = undefined;
        }
        for (const { span } of openTools.values()) span.end();
        openTools.clear();
      }
    });
  };
}

async function loadDefaultRuntime(): Promise<OtelRuntime> {
  let modules: unknown[];
  try {
    modules = await Promise.all(OTEL_SDK_PACKAGES.map((name) => import(name)));
  } catch (cause) {
    // The OTel runtime ships as a regular dependency; reaching this branch
    // means the install is corrupt or a bundler stripped the modules.
    throw new Error(
      `Failed to load the bundled OpenTelemetry runtime (${OTEL_SDK_PACKAGES.join(', ')}). ` +
        `Reinstall @weareikko/code-review or pass startOtelBridge({ runtime }) explicitly.`,
      { cause },
    );
  }
  const [sdkNode, resources, semconv] = modules as [
    { NodeSDK: new (config: unknown) => { start: () => void; shutdown: () => Promise<void> } },
    {
      resourceFromAttributes: (attrs: Record<string, unknown>) => {
        merge: (other: unknown) => unknown;
      };
      defaultResource: () => { merge: (other: unknown) => unknown };
    },
    Record<string, string>,
  ];

  // `@opentelemetry/resources` v2 removed the `Resource` constructor in favor
  // of factory functions. Merge our service-identifying attributes onto the
  // default resource so SDK-detected attributes (telemetry.sdk.*, env-supplied
  // OTEL_RESOURCE_ATTRIBUTES) are preserved.
  const serviceResource = resources.resourceFromAttributes({
    [semconv.ATTR_SERVICE_NAME ?? 'service.name']: SERVICE_NAME,
    [semconv.ATTR_SERVICE_VERSION ?? 'service.version']: __PKG_VERSION__,
  });
  // NodeSDK defaults both OTEL_METRICS_EXPORTER and OTEL_LOGS_EXPORTER to
  // 'otlp' when the env vars are empty. However if the caller explicitly sets
  // them to 'none' (common in CI setups that ship traces but not metrics/logs),
  // we preserve that intent. Setting them here ensures the otlp default takes
  // effect even when the shell exports them as an empty string, which would
  // otherwise be parsed as an unknown exporter and silently ignored.
  process.env.OTEL_METRICS_EXPORTER = process.env.OTEL_METRICS_EXPORTER ?? 'otlp';
  process.env.OTEL_LOGS_EXPORTER = process.env.OTEL_LOGS_EXPORTER ?? 'otlp';

  const sdk = new sdkNode.NodeSDK({
    resource: resources.defaultResource().merge(serviceResource),
    // NodeSDK auto-detects OTLP HTTP/gRPC exporters and a periodic metric
    // reader from OTEL_* env vars and registers both providers globally.
  });
  sdk.start();
  return {
    tracerProvider: trace.getTracerProvider(),
    meterProvider: metrics.getMeterProvider(),
    loggerProvider: logs.getLoggerProvider(),
    shutdown: () => sdk.shutdown(),
  };
}

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

interface RunMeta {
  project: string;
  mr: string;
  gitlabUrl: string;
  /** Low-cardinality CI attributes spread into metric data points. */
  ciAttrs: Record<string, string>;
  /** High-cardinality CI attributes (job/pipeline IDs) used on spans and logs only. */
  ciSpanAttrs: Record<string, string>;
  /**
   * Context capturing the root span so `logger.emit()` can correlate log records
   * to the trace. Populated in `openSpan` for ROOT_PHASE before the span ends.
   */
  rootSpanCtx?: Context;
  /**
   * Configured model string from the ROOT_PHASE context (e.g.
   * `'anthropic/claude-sonnet-4-5'`). Passed to `buildAgentSubscriber` so it
   * can derive `gen_ai.system` when `msg.model` from the agent event stream
   * carries a bare model ID without a provider prefix.
   */
  model?: string;
  /**
   * Whether this run is a dry run. Cached from the ROOT_PHASE context so the
   * per-turn gen_ai.* metrics (emitted from the live agent stream, which has no
   * DiagnosticContext of its own) can carry the same `code_review.dry_run`
   * label as the review-level metrics — otherwise dry-run LLM cost/tokens can
   * never be filtered out of the gen_ai panels.
   */
  dryRun?: boolean;
  usage?: DiagnosticUsage;
  /** Cached from the `scm.post_comments` phase for the drafts-published metric. */
  draftsPublished?: number;
}

function emitReviewStartedLog(
  logger: Logger,
  ctx: DiagnosticContext,
  ciAttrs: Record<string, string>,
  ciSpanAttrs: Record<string, string>,
  rootSpanCtx: Context,
): void {
  const modelId = splitModel(ctx.model ?? '').modelId;
  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: `review started: ${ctx.project} MR#${ctx.mr}`,
    context: rootSpanCtx,
    attributes: {
      'service.name': SERVICE_NAME,
      'event.name': 'code_review.started',
      'vcs.repository.id': ctx.project,
      'vcs.change.id': ctx.mr,
      'vcs.repository.url.full': ctx.gitlabUrl,
      ...ciAttrs,
      ...ciSpanAttrs,
      'code_review.run_id': ctx.runId,
      'code_review.dry_run': ctx.dryRun,
      ...(modelId !== undefined && { 'gen_ai.request.model': modelId }),
    },
  });
}

function emitReviewCompletedLog(
  logger: Logger,
  ctx: DiagnosticContext,
  meta: RunMeta | undefined,
  isError: boolean,
): void {
  const usage = meta?.usage;
  const modelId = splitModel(usage?.model ?? ctx.model ?? '').modelId;
  const cost = usage?.cost.total;
  const costStr = cost !== undefined ? ` $${cost.toFixed(4)}` : '';
  const commentStr = ctx.generated !== undefined ? ` → ${ctx.generated} comments` : '';
  // Failed runs get their own searchable event (code_review.failed) with the
  // error type/message, so an ERROR-level query surfaces every failure.
  // errorInfo.message has the run's own secret values (GitLab token, API key)
  // scrubbed by toDiagnosticError before it ever reaches the context.
  const errorType = errorTypeOf(ctx);
  const body = isError
    ? `review failed: ${ctx.project} MR#${ctx.mr}${ctx.errorInfo ? ` — ${ctx.errorInfo.message}` : ''}`
    : `review completed: ${ctx.project} MR#${ctx.mr}${commentStr}${costStr}`;
  logger.emit({
    severityNumber: isError ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: isError ? 'ERROR' : 'INFO',
    body,
    context: meta?.rootSpanCtx,
    attributes: {
      'service.name': SERVICE_NAME,
      'event.name': isError ? 'code_review.failed' : 'code_review.completed',
      'vcs.repository.id': ctx.project,
      'vcs.change.id': ctx.mr,
      'vcs.repository.url.full': ctx.gitlabUrl,
      ...meta?.ciAttrs,
      ...meta?.ciSpanAttrs,
      ...(isError && {
        'error.type': errorType,
        ...(ctx.errorInfo && { 'error.message': ctx.errorInfo.message }),
        ...(typeof ctx.errorInfo?.status === 'number' && {
          'http.response.status_code': ctx.errorInfo.status,
        }),
      }),
      'code_review.run_id': ctx.runId,
      'code_review.duration_ms': ctx.durationMs ?? 0,
      'code_review.dry_run': ctx.dryRun,
      'code_review.comments.generated': ctx.generated ?? 0,
      'code_review.comments.new': ctx.newComments ?? 0,
      'code_review.comments.duplicate': ctx.duplicateComments ?? 0,
      'code_review.comments.posted': ctx.posted ?? 0,
      ...(modelId !== undefined && { 'gen_ai.request.model': modelId }),
      ...(cost !== undefined && { 'code_review.cost.total_usd': cost }),
      ...(usage?.tokens.input !== undefined && {
        // Total (non-cached + cached) — Sentry AI monitoring model.
        'gen_ai.usage.input_tokens': usage.tokens.input + (usage.tokens.cacheRead ?? 0),
      }),
      ...(usage?.tokens.cacheRead && {
        'gen_ai.usage.input_tokens.cached': usage.tokens.cacheRead,
        // Keep for Grafana backward compat.
        'gen_ai.usage.cache_read.input_tokens': usage.tokens.cacheRead,
      }),
      ...(usage?.tokens.output !== undefined && {
        'gen_ai.usage.output_tokens': usage.tokens.output,
      }),
      ...(usage?.tokens.cacheWrite && {
        'gen_ai.usage.cache_creation.input_tokens': usage.tokens.cacheWrite,
      }),
    },
  });
}

function spanNameFor(phase: DiagnosticPhase): string {
  // OTel GenAI semconv reserves invoke_workflow / invoke_agent / execute_tool
  // as well-known operation names; other phases stay namespaced.
  if (phase === ROOT_PHASE) return 'invoke_workflow code-review';
  if (phase === GEN_AI_PHASE) return 'invoke_agent code-review';
  return `code-review.${phase}`;
}

interface ReviewInstruments {
  reviewRunDuration: Histogram;
  reviewTotalCost: Histogram;
  reviewCommentsTotal: Counter;
  reviewDraftsPublishedTotal: Counter;
  reviewPhaseDuration: Histogram;
  reviewRunsTotal: Counter;
  reviewErrorsTotal: Counter;
  reviewLlmTokens: Record<'input' | 'output' | 'cache_read' | 'cache_creation', Counter>;
}

/** Creates the review-level OTel metric instruments on the given meter. */
function createReviewInstruments(meter: Meter): ReviewInstruments {
  return {
    reviewRunsTotal: meter.createCounter('code_review_runs_total', {
      description: 'Total number of code-review runs, labelled by terminal status',
    }),
    reviewErrorsTotal: meter.createCounter('code_review_errors_total', {
      description: 'Total number of failed code-review runs, labelled by error type',
    }),
    reviewLlmTokens: {
      input: meter.createCounter('code_review_llm_input_tokens_total', {
        description: 'Total non-cached LLM input tokens consumed across code-review runs',
        unit: '{token}',
      }),
      output: meter.createCounter('code_review_llm_output_tokens_total', {
        description: 'Total LLM output tokens generated across code-review runs',
        unit: '{token}',
      }),
      cache_read: meter.createCounter('code_review_llm_cache_read_tokens_total', {
        description: 'Total LLM cache-read input tokens across code-review runs',
        unit: '{token}',
      }),
      cache_creation: meter.createCounter('code_review_llm_cache_creation_tokens_total', {
        description: 'Total LLM cache-creation input tokens across code-review runs',
        unit: '{token}',
      }),
    },
    reviewRunDuration: meter.createHistogram('code_review_run_duration_seconds', {
      description: 'Duration of a complete code-review run',
      unit: 's',
      advice: { explicitBucketBoundaries: REVIEW_RUN_DURATION_BUCKETS_S },
    }),
    reviewTotalCost: meter.createHistogram('code_review_total_cost_usd', {
      description: 'Total LLM cost in USD for a complete code-review run',
      unit: '{usd}',
      advice: { explicitBucketBoundaries: REVIEW_TOTAL_COST_BUCKETS_USD },
    }),
    reviewCommentsTotal: meter.createCounter('code_review_comments_total', {
      description: 'Total number of MR comments posted by code-review',
    }),
    reviewDraftsPublishedTotal: meter.createCounter('code_review_drafts_published_total', {
      description: 'Total number of draft notes published by code-review',
    }),
    reviewPhaseDuration: meter.createHistogram('code_review_phase_duration_seconds', {
      description: 'Duration of individual code-review workflow phases',
      unit: 's',
      advice: { explicitBucketBoundaries: REVIEW_PHASE_DURATION_BUCKETS_S },
    }),
  };
}

/**
 * Stable `error.type` label for a failed run: the typed-error code, else the
 * error class name, else `_OTHER`. Shared by the run/error counters, the failed
 * log record, and the gen_ai duration metric so they never drift.
 *
 * GitLab API failures are refined with their HTTP status (e.g.
 * `GITLAB_API_ERROR_500`) so a 500 on `bulk_publish` is distinguishable from a
 * 404/401 in alerting. HTTP status codes are low-cardinality, so they are safe
 * as a metric label.
 */
function errorTypeOf(ctx: DiagnosticContext): string {
  const base = ctx.errorInfo?.code ?? ctx.errorInfo?.name ?? '_OTHER';
  const status = ctx.errorInfo?.status;
  if (status !== undefined && base === 'GITLAB_API_ERROR') return `${base}_${status}`;
  return base;
}

/**
 * Derives the `code_review.status` label used by review-level OTel metrics.
 * Distinguishes timeouts (AbortError / ETIMEDOUT) from generic errors so
 * Grafana alerts can treat deadline-exceeded runs separately.
 */
function resolveRunStatus(
  ctx: DiagnosticContext,
  isError: boolean,
): 'success' | 'error' | 'timeout' {
  if (!isError) return 'success';
  const { errorInfo } = ctx;
  if (
    errorInfo?.timeout === true ||
    errorInfo?.name === 'AbortError' ||
    errorInfo?.name === 'TimeoutError' ||
    errorInfo?.code === 'ABORT_ERR' ||
    errorInfo?.code === 'ETIMEDOUT'
  ) {
    return 'timeout';
  }
  return 'error';
}

/**
 * Extracts GitLab CI environment variables that add project/pipeline context
 * to every metric, span, and log record. Only populated when running inside a
 * GitLab CI pipeline; callers spread the result so missing vars add nothing.
 */
function buildCiAttrs(env: NodeJS.ProcessEnv): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (env.CI_PROJECT_PATH) attrs['vcs.repository.name'] = env.CI_PROJECT_PATH;
  if (env.CI_PROJECT_NAMESPACE) attrs['vcs.owner.name'] = env.CI_PROJECT_NAMESPACE;
  if (env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME)
    attrs['vcs.ref.base.name'] = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  if (env.CI_PIPELINE_SOURCE) attrs['cicd.pipeline.source'] = env.CI_PIPELINE_SOURCE;
  return attrs;
}

/**
 * Extracts high-cardinality GitLab CI identifiers that should appear on spans
 * and log records but NOT on metric data points (to avoid label explosion in
 * Prometheus/Mimir). Spread results via `ciSpanAttrs` stored in RunMeta.
 */
function buildCiSpanAttrs(env: NodeJS.ProcessEnv): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (env.CI_JOB_ID) attrs['cicd.pipeline.task.run.id'] = env.CI_JOB_ID;
  if (env.CI_PIPELINE_ID) attrs['cicd.pipeline.run.id'] = env.CI_PIPELINE_ID;
  return attrs;
}

function baseAttributes(ctx: DiagnosticContext): Record<string, string | number | boolean> {
  return {
    'code_review.run_id': ctx.runId,
    'gen_ai.conversation.id': ctx.runId,
    'code_review.phase': ctx.phase,
    'vcs.repository.id': ctx.project,
    'vcs.change.id': ctx.mr,
    'vcs.repository.url.full': ctx.gitlabUrl,
    'code_review.dry_run': ctx.dryRun,
    'code_review.no_post': ctx.noPost,
    'code_review.min_severity': ctx.minSeverity,
  };
}

// Numeric DiagnosticContext fields mapped to their result span attribute. Each
// is set only when present as a number, so absent fields add no attribute.
const NUMERIC_RESULT_ATTRIBUTES = [
  ['durationMs', 'code_review.duration_ms'],
  ['generated', 'code_review.comments.generated'],
  ['newComments', 'code_review.comments.new'],
  ['duplicateComments', 'code_review.comments.duplicate'],
  ['posted', 'code_review.comments.posted'],
  ['draftsPublished', 'code_review.drafts.published'],
  ['draftsCreated', 'code_review.drafts.created'],
  ['summaryNoteId', 'code_review.summary.note_id'],
  ['warnings', 'code_review.warnings'],
  ['draftsAbandoned', 'code_review.drafts.abandoned'],
  ['draftsDeletedPrePublish', 'code_review.drafts.deleted_pre_publish'],
  ['draftsPublishFailed', 'code_review.drafts.publish_failed'],
  ['diffFilesChanged', 'diff.files_changed'],
  ['diffLinesAdded', 'diff.lines_added'],
  ['diffLinesRemoved', 'diff.lines_removed'],
  // GitLab API spans — numeric HTTP semantic-convention attributes.
  ['httpStatusCode', 'http.response.status_code'],
  ['httpResponseBodySize', 'http.response.body.size'],
] as const satisfies ReadonlyArray<readonly [keyof DiagnosticContext, string]>;

// String DiagnosticContext fields mapped to their result span attribute. Each
// is set only when present as a string. HTTP keys follow the stable OTel HTTP
// semantic conventions (http.request.method, url.full, server.address).
const STRING_RESULT_ATTRIBUTES = [
  ['summaryAction', 'code_review.summary.action'],
  ['httpRequestMethod', 'http.request.method'],
  ['httpUrl', 'url.full'],
  ['serverAddress', 'server.address'],
] as const satisfies ReadonlyArray<readonly [keyof DiagnosticContext, string]>;

function applyResultAttributes(span: Span, ctx: DiagnosticContext): void {
  for (const [field, attr] of NUMERIC_RESULT_ATTRIBUTES) {
    const value = ctx[field];
    if (typeof value === 'number') span.setAttribute(attr, value);
  }
  for (const [field, attr] of STRING_RESULT_ATTRIBUTES) {
    const value = ctx[field];
    if (typeof value === 'string') span.setAttribute(attr, value);
  }
}

function applyGenAiAttributes(span: Span, ctx: DiagnosticContext): void {
  // OpenTelemetry GenAI semantic conventions — currently experimental, opt-in
  // via OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental.
  // Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
  const { provider, modelId } = splitModel(ctx.model ?? '');
  if (provider) {
    span.setAttribute('gen_ai.provider.name', provider);
    span.setAttribute('gen_ai.system', provider);
  }
  if (modelId) {
    span.setAttribute('gen_ai.request.model', modelId);
    span.setAttribute('gen_ai.response.model', modelId);
  }
  span.setAttribute('gen_ai.operation.name', 'invoke_agent');
  span.setAttribute('gen_ai.agent.name', 'code-review');

  const usage = ctx.usage;
  if (!usage) return;
  setTokenUsageSpanAttributes(span, usage.tokens);
  // Cost is not standardized by OTel GenAI semconv — emit under a clearly
  // namespaced custom attribute. Revisit when the spec stabilizes a cost field.
  span.setAttribute('code_review.cost.input_usd', usage.cost.input);
  span.setAttribute('code_review.cost.output_usd', usage.cost.output);
  span.setAttribute('code_review.cost.cache_read_usd', usage.cost.cacheRead);
  span.setAttribute('code_review.cost.cache_creation_usd', usage.cost.cacheWrite);
  span.setAttribute('code_review.cost.total_usd', usage.cost.total);
}

/**
 * Records `gen_ai.client.operation.duration` for the `reviewer.run` phase.
 *
 * Token usage (`gen_ai.client.token.usage`) and cost (`code_review_llm_cost_usd`) are
 * intentionally NOT recorded here. They are emitted per-turn by
 * `buildAgentSubscriber` from the live agent event stream. Keeping a single
 * emission point for each metric prevents the double-count that previously
 * occurred (two Prometheus series per run, one with and one without
 * `gen_ai_system`, summing to 2× the real value in Grafana).
 */
function recordGenAiMetrics(
  durationHist: Histogram,
  ctx: DiagnosticContext,
  isError: boolean,
  ciAttrs: Record<string, string> = {},
): void {
  const { provider, modelId } = splitModel(ctx.model ?? '');
  // gen_ai.request.model only (gen_ai.response.model belongs on spans, not metrics).
  const attrs: Attributes = {
    'gen_ai.operation.name': 'invoke_agent',
    ...REVIEW_SERVICE_ATTRS,
    ...ciAttrs,
    ...genAiModelAttrs(provider, modelId),
    'code_review.dry_run': ctx.dryRun,
  };
  if (isError) {
    attrs['error.type'] = errorTypeOf(ctx);
  }
  if (typeof ctx.durationMs === 'number') {
    durationHist.record(ctx.durationMs / 1000, attrs);
  }
}
