/**
 * Optional OpenTelemetry bridge over `diagnostics_channel` and the agent
 * event stream.
 *
 * Subscribes to every `@ikko-dev/gitlab-review:*` tracing channel, opens an
 * OTel span on `start`, and closes it on `asyncEnd`/`error`. The `reviewer.run`
 * phase additionally carries OpenTelemetry GenAI semantic-convention
 * attributes (`gen_ai.*`) and emits the standardized GenAI client metrics
 * (`gen_ai.client.operation.duration`, `gen_ai.client.token.usage`,
 * `gen_ai.client.cost`, `gen_ai.client.time_to_first_token`) so
 * metrics-driven AI observability surfaces auto-discover the service.
 *
 * Per-turn and per-tool-call telemetry is captured via `createAgentTelemetry`,
 * which subscribes to the agent's live event stream and emits:
 *   - `gen_ai.agent.turn` child spans under `invoke_agent gitlab-review`
 *   - `execute_tool <name>` grandchild spans under each turn
 *   - Per-turn `gen_ai.client.token.usage` and `gen_ai.client.cost` metrics
 *   - `gen_ai.client.time_to_first_token` when streaming events fire
 *
 * Opt-in: set `GITLAB_REVIEW_OTEL=1`. Exporter selection and endpoint follow
 * the standard `OTEL_*` env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, …).
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
import type { GeneratedComment } from './types.js';

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
   * `gitlab_review.comment.*` attributes, and the comment body as the log
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
}

const ROOT_PHASE: DiagnosticPhase = 'run';
const GEN_AI_PHASE: DiagnosticPhase = 'reviewer.run';
const SERVICE_NAME = '@ikko-dev/gitlab-review';

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
  return env.GITLAB_REVIEW_OTEL === '1' || env.GITLAB_REVIEW_OTEL === 'true';
}

export async function startOtelBridge(options: OtelBridgeOptions = {}): Promise<OtelBridge | null> {
  const env = options.env ?? process.env;
  if (!isOtelEnabled(env)) return null;

  const ciAttrs = buildCiAttrs(env);

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
  const operationCost = meter.createHistogram('gen_ai.client.cost', {
    description: 'GenAI operation cost in USD',
    unit: 'usd',
    advice: { explicitBucketBoundaries: COST_BUCKETS_USD },
  });
  const timeToFirstToken = meter.createHistogram('gen_ai.client.time_to_first_token', {
    description: 'Time to first token from the LLM',
    unit: 's',
    advice: { explicitBucketBoundaries: TTFT_BUCKETS_S },
  });

  const openByRun = new Map<string, Map<DiagnosticPhase, OpenSpan>>();

  // Per-run metadata cached from the ROOT_PHASE context for use in the review
  // completion log and in logComments attribute enrichment.
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
    if (phases.has(ctx.phase)) return;
    const span = tracer.startSpan(
      spanNameFor(ctx.phase),
      { kind: SpanKind.INTERNAL, attributes: { ...baseAttributes(ctx), ...ciAttrs } },
      parentContext(ctx.runId),
    );
    phases.set(ctx.phase, { span, closed: false });
    // Seed run metadata so logComments and the review completion log can enrich
    // records with project/mr context even before the run phase closes.
    if (ctx.phase === ROOT_PHASE) {
      runMeta.set(ctx.runId, {
        project: ctx.project,
        mr: ctx.mr,
        gitlabUrl: ctx.gitlabUrl,
        ciAttrs,
      });
    }
  };

  const closeSpan = (ctx: DiagnosticContext, isError: boolean): void => {
    const entry = openByRun.get(ctx.runId)?.get(ctx.phase);
    if (!entry || entry.closed) return;
    if (ctx.phase === GEN_AI_PHASE) {
      applyGenAiAttributes(entry.span, ctx);
      recordGenAiMetrics(operationDuration, tokenUsage, operationCost, ctx, isError, ciAttrs);
      // Cache usage so the ROOT_PHASE completion log can include cost/token totals.
      if (ctx.usage) {
        const meta = runMeta.get(ctx.runId);
        if (meta) meta.usage = ctx.usage;
      }
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
    if (ctx.phase === ROOT_PHASE) {
      emitReviewCompletedLog(logger, ctx, runMeta.get(ctx.runId), isError);
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
          attributes: {
            'event.name': 'gitlab_review.comment',
            'gitlab_review.run_id': runId,
            'gitlab_review.comment.file': comment.file,
            'gitlab_review.comment.line': comment.line,
            'gitlab_review.comment.severity': comment.severity,
            'gitlab_review.comment.is_duplicate': duplicate,
            ...(meta && {
              'gitlab.project_id': meta.project,
              'gitlab.mr_iid': meta.mr,
              'gitlab.server_url': meta.gitlabUrl,
              ...meta.ciAttrs,
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
        ciAttrs,
      );
    },
  };
}

function buildAgentSubscriber(
  tracer: Tracer,
  tokenUsage: Histogram,
  operationCost: Histogram,
  timeToFirstToken: Histogram,
  reviewerSpanCtx: ReturnType<typeof trace.setSpan>,
  ciAttrs: Record<string, string> = {},
): (agent: AgentLike) => () => void {
  return (agent: AgentLike): (() => void) => {
    let currentTurn: { span: Span; startMs: number; firstTokenMs?: number } | undefined;
    const openTools = new Map<string, Span>();

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

        const rawModel = String(msg.model ?? '');
        const modelId = rawModel.includes('/') ? rawModel.split('/')[1] : rawModel || undefined;
        const metricAttrs: Attributes = { 'gen_ai.operation.name': 'invoke_agent', ...ciAttrs };
        if (modelId) {
          metricAttrs['gen_ai.request.model'] = modelId;
          metricAttrs['gen_ai.response.model'] = modelId;
          span.setAttribute('gen_ai.response.model', modelId);
        }
        if (msg.stopReason) span.setAttribute('gen_ai.response.stop_reason', msg.stopReason);

        if (firstTokenMs !== undefined) {
          const ttftS = (firstTokenMs - startMs) / 1000;
          timeToFirstToken.record(ttftS, metricAttrs);
          span.setAttribute('gen_ai.client.time_to_first_token_s', ttftS);
        }

        if (msg.usage) {
          const u = msg.usage;
          tokenUsage.record(u.input, { ...metricAttrs, 'gen_ai.token.type': 'input' });
          tokenUsage.record(u.output, { ...metricAttrs, 'gen_ai.token.type': 'output' });
          span.setAttribute('gen_ai.usage.input_tokens', u.input);
          span.setAttribute('gen_ai.usage.output_tokens', u.output);
          if (u.cacheRead) span.setAttribute('gen_ai.usage.cache_read.input_tokens', u.cacheRead);
          if (u.cacheWrite)
            span.setAttribute('gen_ai.usage.cache_creation.input_tokens', u.cacheWrite);
          if (u.cost) {
            operationCost.record(u.cost.total, metricAttrs);
            span.setAttribute('gen_ai.usage.cost.input_usd', u.cost.input);
            span.setAttribute('gen_ai.usage.cost.output_usd', u.cost.output);
            span.setAttribute('gen_ai.usage.cost.total_usd', u.cost.total);
          }
        }
        span.end();
      }

      if (type === 'tool_execution_start') {
        const { toolName, toolCallId } = event as { toolName?: string; toolCallId?: string };
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
        openTools.set(toolCallId, toolSpan);
      }

      if (type === 'tool_execution_end') {
        const { toolCallId, isError } = event as { toolCallId?: string; isError?: boolean };
        if (!toolCallId) return;
        const span = openTools.get(toolCallId);
        if (!span) return;
        if (isError) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        openTools.delete(toolCallId);
      }

      if (type === 'agent_end') {
        if (currentTurn) {
          currentTurn.span.end();
          currentTurn = undefined;
        }
        for (const span of openTools.values()) span.end();
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
        `Reinstall @ikko-dev/gitlab-review or pass startOtelBridge({ runtime }) explicitly.`,
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
  ciAttrs: Record<string, string>;
  usage?: DiagnosticUsage;
}

function emitReviewCompletedLog(
  logger: Logger,
  ctx: DiagnosticContext,
  meta: RunMeta | undefined,
  isError: boolean,
): void {
  const usage = meta?.usage;
  const rawModel = usage?.model ?? ctx.model ?? '';
  const modelId = rawModel.includes('/') ? rawModel.split('/')[1] : rawModel || undefined;
  const cost = usage?.cost.total;
  const costStr = cost !== undefined ? ` $${cost.toFixed(4)}` : '';
  const commentStr = ctx.generated !== undefined ? ` → ${ctx.generated} comments` : '';
  logger.emit({
    severityNumber: isError ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: isError ? 'ERROR' : 'INFO',
    body: `review completed: ${ctx.project} MR#${ctx.mr}${commentStr}${costStr}`,
    attributes: {
      'event.name': 'gitlab_review.completed',
      'gitlab.project_id': ctx.project,
      'gitlab.mr_iid': ctx.mr,
      'gitlab.server_url': ctx.gitlabUrl,
      ...(meta?.ciAttrs ?? {}),
      'gitlab_review.run_id': ctx.runId,
      'gitlab_review.duration_ms': ctx.durationMs ?? 0,
      'gitlab_review.dry_run': ctx.dryRun,
      'gitlab_review.comments.generated': ctx.generated ?? 0,
      'gitlab_review.comments.new': ctx.newComments ?? 0,
      'gitlab_review.comments.duplicate': ctx.duplicateComments ?? 0,
      'gitlab_review.comments.posted': ctx.posted ?? 0,
      ...(modelId !== undefined && { 'gen_ai.request.model': modelId }),
      ...(cost !== undefined && { 'gen_ai.usage.cost.total_usd': cost }),
      ...(usage?.tokens.input !== undefined && {
        'gen_ai.usage.input_tokens': usage.tokens.input,
      }),
      ...(usage?.tokens.output !== undefined && {
        'gen_ai.usage.output_tokens': usage.tokens.output,
      }),
      ...(usage?.tokens.cacheRead && {
        'gen_ai.usage.cache_read.input_tokens': usage.tokens.cacheRead,
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
  if (phase === ROOT_PHASE) return 'invoke_workflow gitlab-review';
  if (phase === GEN_AI_PHASE) return 'invoke_agent gitlab-review';
  return `gitlab-review.${phase}`;
}

/**
 * Extracts GitLab CI environment variables that add project/pipeline context
 * to every metric, span, and log record. Only populated when running inside a
 * GitLab CI pipeline; callers spread the result so missing vars add nothing.
 */
function buildCiAttrs(env: NodeJS.ProcessEnv): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (env.CI_PROJECT_PATH) attrs['gitlab.project_path'] = env.CI_PROJECT_PATH;
  if (env.CI_PROJECT_NAMESPACE) attrs['gitlab.project_namespace'] = env.CI_PROJECT_NAMESPACE;
  if (env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME)
    attrs['gitlab.mr_target_branch'] = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  if (env.CI_PIPELINE_SOURCE) attrs['gitlab.pipeline_source'] = env.CI_PIPELINE_SOURCE;
  return attrs;
}

function baseAttributes(ctx: DiagnosticContext): Record<string, string | number | boolean> {
  return {
    'gitlab_review.run_id': ctx.runId,
    'gitlab_review.phase': ctx.phase,
    'gitlab.project_id': ctx.project,
    'gitlab.mr_iid': ctx.mr,
    'gitlab.server_url': ctx.gitlabUrl,
    'gitlab_review.dry_run': ctx.dryRun,
    'gitlab_review.no_post': ctx.noPost,
    'gitlab_review.min_severity': ctx.minSeverity,
  };
}

function applyResultAttributes(span: Span, ctx: DiagnosticContext): void {
  if (typeof ctx.durationMs === 'number') {
    span.setAttribute('gitlab_review.duration_ms', ctx.durationMs);
  }
  if (typeof ctx.generated === 'number') {
    span.setAttribute('gitlab_review.comments.generated', ctx.generated);
  }
  if (typeof ctx.newComments === 'number') {
    span.setAttribute('gitlab_review.comments.new', ctx.newComments);
  }
  if (typeof ctx.duplicateComments === 'number') {
    span.setAttribute('gitlab_review.comments.duplicate', ctx.duplicateComments);
  }
  if (typeof ctx.posted === 'number') {
    span.setAttribute('gitlab_review.comments.posted', ctx.posted);
  }
  if (typeof ctx.draftsPublished === 'number') {
    span.setAttribute('gitlab_review.drafts.published', ctx.draftsPublished);
  }
  if (typeof ctx.draftsCreated === 'number') {
    span.setAttribute('gitlab_review.drafts.created', ctx.draftsCreated);
  }
  if (typeof ctx.summaryAction === 'string') {
    span.setAttribute('gitlab_review.summary.action', ctx.summaryAction);
  }
  if (typeof ctx.summaryNoteId === 'number') {
    span.setAttribute('gitlab_review.summary.note_id', ctx.summaryNoteId);
  }
}

function applyGenAiAttributes(span: Span, ctx: DiagnosticContext): void {
  // OpenTelemetry GenAI semantic conventions — currently experimental, opt-in
  // via OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental.
  // Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
  const [provider, modelId] = (ctx.model ?? '').split('/');
  if (provider) span.setAttribute('gen_ai.provider.name', provider);
  if (modelId) {
    span.setAttribute('gen_ai.request.model', modelId);
    span.setAttribute('gen_ai.response.model', modelId);
  }
  span.setAttribute('gen_ai.operation.name', 'invoke_agent');
  span.setAttribute('gen_ai.agent.name', 'gitlab-review');

  const usage = ctx.usage;
  if (!usage) return;
  span.setAttribute('gen_ai.usage.input_tokens', usage.tokens.input);
  span.setAttribute('gen_ai.usage.output_tokens', usage.tokens.output);
  if (usage.tokens.cacheRead) {
    span.setAttribute('gen_ai.usage.cache_read.input_tokens', usage.tokens.cacheRead);
  }
  if (usage.tokens.cacheWrite) {
    span.setAttribute('gen_ai.usage.cache_creation.input_tokens', usage.tokens.cacheWrite);
  }
  // Cost is not standardized by OTel GenAI semconv — emit under a clearly
  // namespaced custom attribute. Revisit when the spec stabilizes a cost field.
  span.setAttribute('gen_ai.usage.cost.input_usd', usage.cost.input);
  span.setAttribute('gen_ai.usage.cost.output_usd', usage.cost.output);
  span.setAttribute('gen_ai.usage.cost.cache_read_usd', usage.cost.cacheRead);
  span.setAttribute('gen_ai.usage.cost.cache_write_usd', usage.cost.cacheWrite);
  span.setAttribute('gen_ai.usage.cost.total_usd', usage.cost.total);
}

function recordGenAiMetrics(
  durationHist: Histogram,
  tokenHist: Histogram,
  costHist: Histogram,
  ctx: DiagnosticContext,
  isError: boolean,
  ciAttrs: Record<string, string> = {},
): void {
  const [provider, modelId] = (ctx.model ?? '').split('/');
  const attrs: Attributes = { 'gen_ai.operation.name': 'invoke_agent', ...ciAttrs };
  if (provider) attrs['gen_ai.provider.name'] = provider;
  if (modelId) {
    attrs['gen_ai.request.model'] = modelId;
    attrs['gen_ai.response.model'] = modelId;
  }
  if (isError) {
    attrs['error.type'] = ctx.errorInfo?.code ?? ctx.errorInfo?.name ?? '_OTHER';
  }
  if (typeof ctx.durationMs === 'number') {
    durationHist.record(ctx.durationMs / 1000, attrs);
  }
  if (ctx.usage) {
    tokenHist.record(ctx.usage.tokens.input, { ...attrs, 'gen_ai.token.type': 'input' });
    tokenHist.record(ctx.usage.tokens.output, { ...attrs, 'gen_ai.token.type': 'output' });
    costHist.record(ctx.usage.cost.total, attrs);
  }
}
