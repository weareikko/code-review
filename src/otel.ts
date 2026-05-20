/**
 * Optional OpenTelemetry bridge over `diagnostics_channel`.
 *
 * Subscribes to every `@ikko-dev/gitlab-review:*` tracing channel, opens an
 * OTel span on `start`, and closes it on `asyncEnd`/`error`. The `reviewer.run`
 * phase additionally carries OpenTelemetry GenAI semantic-convention
 * attributes (`gen_ai.*`) and emits the standardized GenAI client metrics
 * (`gen_ai.client.operation.duration`, `gen_ai.client.token.usage`) so
 * metrics-driven AI observability surfaces (Grafana Application Observability,
 * Datadog LLM Observability, …) auto-discover the service.
 *
 * Opt-in: set `GITLAB_REVIEW_OTEL=1`. Exporter selection and endpoint follow
 * the standard `OTEL_*` env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, …). For Grafana Sigil, set the endpoint and
 * the `OTEL_EXPORTER_OTLP_HEADERS` to carry the Cloud Access Policy Token.
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
import { diagnosticChannels, type DiagnosticContext, type DiagnosticPhase } from './diagnostics.js';

// Inlined at build time by Vite's `define` (see vite.config.ts). Keeps
// `service.version` accurate under `npx`/standalone bin invocations, where
// `npm_package_version` from `npm run` is not set.
declare const __PKG_VERSION__: string;

export interface OtelBridge {
  shutdown(): Promise<void>;
}

export interface OtelRuntime {
  tracerProvider: TracerProvider;
  meterProvider: MeterProvider;
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

export function isOtelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITLAB_REVIEW_OTEL === '1' || env.GITLAB_REVIEW_OTEL === 'true';
}

export async function startOtelBridge(options: OtelBridgeOptions = {}): Promise<OtelBridge | null> {
  const env = options.env ?? process.env;
  if (!isOtelEnabled(env)) return null;

  const runtime = options.runtime ?? (await loadDefaultRuntime());
  const tracer: Tracer = runtime.tracerProvider.getTracer(SERVICE_NAME);
  const meter: Meter = runtime.meterProvider.getMeter(SERVICE_NAME);

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

  const openByRun = new Map<string, Map<DiagnosticPhase, OpenSpan>>();

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
      { kind: SpanKind.INTERNAL, attributes: baseAttributes(ctx) },
      parentContext(ctx.runId),
    );
    phases.set(ctx.phase, { span, closed: false });
  };

  const closeSpan = (ctx: DiagnosticContext, isError: boolean): void => {
    const entry = openByRun.get(ctx.runId)?.get(ctx.phase);
    if (!entry || entry.closed) return;
    if (ctx.phase === GEN_AI_PHASE) {
      applyGenAiAttributes(entry.span, ctx);
      recordGenAiMetrics(operationDuration, tokenUsage, ctx, isError);
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
    if (ctx.phase === ROOT_PHASE) openByRun.delete(ctx.runId);
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
      await runtime.shutdown();
    },
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
  const sdk = new sdkNode.NodeSDK({
    resource: resources.defaultResource().merge(serviceResource),
    // NodeSDK auto-detects OTLP HTTP/gRPC exporters and a periodic metric
    // reader from OTEL_* env vars and registers both providers globally.
  });
  sdk.start();
  return {
    tracerProvider: trace.getTracerProvider(),
    meterProvider: metrics.getMeterProvider(),
    shutdown: () => sdk.shutdown(),
  };
}

function spanNameFor(phase: DiagnosticPhase): string {
  // OTel GenAI semconv reserves invoke_workflow / invoke_agent / execute_tool
  // as well-known operation names; other phases stay namespaced.
  if (phase === ROOT_PHASE) return 'invoke_workflow gitlab-review';
  if (phase === GEN_AI_PHASE) return 'invoke_agent gitlab-review';
  return `gitlab-review.${phase}`;
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
  ctx: DiagnosticContext,
  isError: boolean,
): void {
  const [provider, modelId] = (ctx.model ?? '').split('/');
  const attrs: Attributes = { 'gen_ai.operation.name': 'invoke_agent' };
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
  }
}
