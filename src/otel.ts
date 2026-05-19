/**
 * Optional OpenTelemetry bridge over `diagnostics_channel`.
 *
 * Subscribes to every `@ikko-dev/gitlab-review:*` tracing channel, opens an
 * OTel span on `start`, and closes it on `asyncEnd`/`error`. The `reviewer.run`
 * phase additionally carries OpenTelemetry GenAI semantic-convention
 * attributes (`gen_ai.*`), with token counts and cost threaded in via the
 * `DiagnosticUsage` field on the run/reviewer.run context.
 *
 * Opt-in: set `GITLAB_REVIEW_OTEL=1`. Exporter selection and endpoint follow
 * the standard `OTEL_*` env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, …). For Grafana Sigil, set the endpoint and
 * the `OTEL_EXPORTER_OTLP_HEADERS` to carry the Cloud Access Policy Token.
 *
 * The OTel runtime is bundled but loaded via dynamic `import()` behind the
 * env check, so disabling the bridge skips the SDK boot entirely. Library
 * callers who already have a configured `TracerProvider` in their process can
 * inject their own runtime via `startOtelBridge({ runtime })` so spans join
 * the host tracer instead of a second `NodeSDK`.
 */

import { diagnosticChannels, type DiagnosticContext, type DiagnosticPhase } from './diagnostics.js';

export interface OtelBridge {
  shutdown(): Promise<void>;
}

// Minimal structural typings for the OTel surface we touch — keeps this file
// independent of `@opentelemetry/api` typings and gives callers a clear DI
// contract.
export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(exception: { name?: string; message: string }): void;
  end(): void;
}
export interface OtelTracer {
  startSpan(name: string, options?: unknown, context?: unknown): OtelSpan;
}
export interface OtelApi {
  trace: {
    getTracer(name: string): OtelTracer;
    setSpan(ctx: unknown, span: OtelSpan): unknown;
  };
  context: { active(): unknown };
  SpanKind: { INTERNAL: number };
  SpanStatusCode: { ERROR: number };
}

export interface OtelRuntime {
  api: OtelApi;
  shutdown(): Promise<void>;
}

export interface OtelBridgeOptions {
  /**
   * Pre-wired OTel runtime. When provided, the bridge uses the supplied API
   * and skips dynamic import of `@opentelemetry/*`. Library callers with a
   * configured `TracerProvider` should pass their own `api` plus a no-op
   * `shutdown`; tests inject a fake API with assertion hooks.
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

const OTEL_PACKAGES = [
  '@opentelemetry/api',
  '@opentelemetry/sdk-node',
  '@opentelemetry/resources',
  '@opentelemetry/semantic-conventions',
] as const;

const noop = (): void => undefined;

interface OpenSpan {
  span: OtelSpan;
  closed: boolean;
}

export function isOtelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITLAB_REVIEW_OTEL === '1' || env.GITLAB_REVIEW_OTEL === 'true';
}

export async function startOtelBridge(options: OtelBridgeOptions = {}): Promise<OtelBridge | null> {
  const env = options.env ?? process.env;
  if (!isOtelEnabled(env)) return null;

  const runtime = options.runtime ?? (await loadDefaultRuntime());
  const { api } = runtime;
  const tracer = api.trace.getTracer(SERVICE_NAME);
  const openByRun = new Map<string, Map<DiagnosticPhase, OpenSpan>>();

  const parentContext = (runId: string): unknown => {
    const root = openByRun.get(runId)?.get(ROOT_PHASE);
    return root && !root.closed
      ? api.trace.setSpan(api.context.active(), root.span)
      : api.context.active();
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
      { kind: api.SpanKind.INTERNAL, attributes: baseAttributes(ctx) },
      parentContext(ctx.runId),
    );
    phases.set(ctx.phase, { span, closed: false });
  };

  const closeSpan = (ctx: DiagnosticContext, isError: boolean): void => {
    const entry = openByRun.get(ctx.runId)?.get(ctx.phase);
    if (!entry || entry.closed) return;
    if (ctx.phase === GEN_AI_PHASE) applyGenAiAttributes(entry.span, ctx);
    applyResultAttributes(entry.span, ctx);
    if (isError && ctx.errorInfo) {
      entry.span.recordException(ctx.errorInfo);
      entry.span.setStatus({
        code: api.SpanStatusCode.ERROR,
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
    modules = await Promise.all(OTEL_PACKAGES.map((name) => import(name)));
  } catch (cause) {
    // The OTel runtime ships as a regular dependency; reaching this branch
    // means the install is corrupt or a bundler stripped the modules.
    throw new Error(
      `Failed to load the bundled OpenTelemetry runtime (${OTEL_PACKAGES.join(', ')}). ` +
        `Reinstall @ikko-dev/gitlab-review or pass startOtelBridge({ runtime }) explicitly.`,
      { cause },
    );
  }
  const [api, sdkNode, resources, semconv] = modules as [
    OtelApi,
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
    [semconv.ATTR_SERVICE_VERSION ?? 'service.version']: process.env.npm_package_version ?? '0.0.0',
  });
  const sdk = new sdkNode.NodeSDK({
    resource: resources.defaultResource().merge(serviceResource),
    // NodeSDK auto-detects OTLP HTTP/gRPC exporters from OTEL_* env vars.
  });
  sdk.start();
  return { api, shutdown: () => sdk.shutdown() };
}

function spanNameFor(phase: DiagnosticPhase): string {
  // OTel GenAI semconv reserves invoke_workflow / invoke_agent / execute_tool
  // as well-known operation names; other phases stay namespaced.
  if (phase === ROOT_PHASE) return 'invoke_workflow gitlab-review';
  if (phase === GEN_AI_PHASE) return 'invoke_agent pi-reviewer';
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

function applyResultAttributes(span: OtelSpan, ctx: DiagnosticContext): void {
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

function applyGenAiAttributes(span: OtelSpan, ctx: DiagnosticContext): void {
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
  span.setAttribute('gen_ai.agent.name', 'pi-reviewer');

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
