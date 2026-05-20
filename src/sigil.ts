/**
 * Optional Grafana AI Observability (Sigil) bridge over `diagnostics_channel`.
 *
 * Subscribes to the `@ikko-dev/gitlab-review:reviewer.run` tracing channel
 * and forwards generation telemetry to Grafana AI Observability via
 * `@grafana/sigil-sdk-js`.
 *
 * Opt-in: set `GITLAB_REVIEW_SIGIL=1` (or pass `--sigil`). The Sigil client
 * is dynamically loaded only when enabled — omitting the env var costs nothing
 * at startup.
 *
 * Configure the generation endpoint and auth through `SIGIL_*` env vars as
 * shown in Grafana AI Observability → Configuration (e.g. `SIGIL_ENDPOINT`,
 * `SIGIL_AUTH_TENANT_ID`, `SIGIL_AUTH_TOKEN`, …). Unlike `GITLAB_REVIEW_OTEL`
 * (which sends generic OTLP spans and metrics), `GITLAB_REVIEW_SIGIL` sends
 * generation-level records to Grafana AI Observability and is NOT OTLP.
 *
 * Content capture is controlled by `SIGIL_CONTENT_CAPTURE_MODE` (or the
 * `--sigil-capture-mode` CLI flag):
 * - `metadata_only` (default): token counts, costs, model names, timing, and
 *   project/MR identifiers only. No diff, prompt, or review body content.
 * - `no_tool_content` / `full`: accepted at the SDK level; message content is
 *   not yet captured in the diagnostic context so these modes behave like
 *   `metadata_only` in practice. Passing the mode ensures the SDK honours it
 *   if message data is added to diagnostics in a future release.
 *
 * Library callers with a pre-configured `SigilClient` can inject it via
 * `startSigilBridge({ client })` to skip the default client boot and share a
 * single instance. Tests inject fakes with assertion hooks the same way.
 */

import type {
  ContentCaptureMode,
  GenerationRecorder,
  GenerationResult,
  SigilClient as SigilClientType,
} from '@grafana/sigil-sdk-js';
import type { SigilContentCaptureMode } from './config.js';
import { SIGIL_CAPTURE_MODES } from './config.js';
import { diagnosticChannels, type DiagnosticContext } from './diagnostics.js';

// Inlined at build time by Vite's `define` (see vite.config.ts). Keeps
// `agentVersion` accurate under `npx`/standalone bin invocations, where
// `npm_package_version` from `npm run` is not set.
declare const __PKG_VERSION__: string;

export interface SigilBridge {
  shutdown(): Promise<void>;
}

export interface SigilBridgeOptions {
  /**
   * Pre-wired Sigil client. When provided, the bridge uses the supplied
   * client and skips dynamic import of `@grafana/sigil-sdk-js`. Tests inject
   * fakes with assertion hooks; library callers with an existing client pass
   * it here to share a single instance.
   */
  client?: SigilClientType;
  /**
   * Override the env source used for the opt-in check and capture-mode
   * resolution. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Content capture mode override. When supplied, takes precedence over
   * `SIGIL_CONTENT_CAPTURE_MODE`. Defaults to `metadata_only` when neither
   * is set.
   */
  captureMode?: SigilContentCaptureMode;
}

export function isSigilEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITLAB_REVIEW_SIGIL === '1' || env.GITLAB_REVIEW_SIGIL === 'true';
}

export async function startSigilBridge(
  options: SigilBridgeOptions = {},
): Promise<SigilBridge | null> {
  const env = options.env ?? process.env;
  if (!isSigilEnabled(env)) return null;

  const captureMode = resolveCaptureMode(options.captureMode, env);
  // Our SigilContentCaptureMode values are a strict subset of the SDK's
  // ContentCaptureMode — the cast is safe.
  const sdkMode = captureMode as ContentCaptureMode;

  const client = options.client ?? (await loadDefaultClient());

  const openByRun = new Map<string, GenerationRecorder>();

  const handlers = {
    start: (ctx: DiagnosticContext) => {
      const { provider, name } = parseModel(ctx.model ?? '');
      const recorder = client.startGeneration({
        conversationId: ctx.runId,
        agentName: 'gitlab-review',
        agentVersion: __PKG_VERSION__,
        model: {
          provider: provider || 'unknown',
          name: name || ctx.model || 'unknown',
        },
        contentCapture: sdkMode,
        startedAt: ctx.startedAt ? new Date(ctx.startedAt) : undefined,
        metadata: buildStartMetadata(ctx),
      });
      openByRun.set(ctx.runId, recorder);
    },
    end: noop,
    asyncStart: noop,
    asyncEnd: (ctx: DiagnosticContext) => {
      const recorder = openByRun.get(ctx.runId);
      if (!recorder) return;
      openByRun.delete(ctx.runId);
      const result: GenerationResult = {
        completedAt: ctx.completedAt ? new Date(ctx.completedAt) : new Date(),
        metadata: buildResultMetadata(ctx),
      };
      if (ctx.usage) {
        result.usage = {
          inputTokens: ctx.usage.tokens.input,
          outputTokens: ctx.usage.tokens.output,
          totalTokens: ctx.usage.tokens.total,
          // Only set cache tokens when non-zero to keep the payload clean.
          ...(ctx.usage.tokens.cacheRead > 0
            ? { cacheReadInputTokens: ctx.usage.tokens.cacheRead }
            : {}),
          ...(ctx.usage.tokens.cacheWrite > 0
            ? { cacheWriteInputTokens: ctx.usage.tokens.cacheWrite }
            : {}),
        };
      }
      recorder.setResult(result);
      recorder.end();
    },
    error: (ctx: DiagnosticContext) => {
      const recorder = openByRun.get(ctx.runId);
      if (!recorder) return;
      openByRun.delete(ctx.runId);
      if (ctx.errorInfo) {
        const err = Object.assign(new Error(ctx.errorInfo.message), {
          name: ctx.errorInfo.name ?? 'Error',
          ...(ctx.errorInfo.code ? { code: ctx.errorInfo.code } : {}),
        });
        recorder.setCallError(err);
      }
      recorder.end();
    },
  };

  diagnosticChannels.runReviewer.subscribe(handlers);

  return {
    async shutdown() {
      diagnosticChannels.runReviewer.unsubscribe(handlers);
      // End any recorders that were never closed (e.g. process killed mid-run).
      for (const recorder of openByRun.values()) {
        recorder.end();
      }
      openByRun.clear();
      await client.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStartMetadata(ctx: DiagnosticContext): Record<string, unknown> {
  return {
    'gitlab.project_id': ctx.project,
    'gitlab.mr_iid': ctx.mr,
    'gitlab.server_url': ctx.gitlabUrl,
    'gitlab_review.run_id': ctx.runId,
    'gitlab_review.dry_run': ctx.dryRun,
    'gitlab_review.no_post': ctx.noPost,
    'gitlab_review.min_severity': ctx.minSeverity,
  };
}

function buildResultMetadata(ctx: DiagnosticContext): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (typeof ctx.durationMs === 'number') meta['gitlab_review.duration_ms'] = ctx.durationMs;
  if (typeof ctx.generated === 'number') meta['gitlab_review.comments.generated'] = ctx.generated;
  if (typeof ctx.newComments === 'number') meta['gitlab_review.comments.new'] = ctx.newComments;
  if (typeof ctx.duplicateComments === 'number') {
    meta['gitlab_review.comments.duplicate'] = ctx.duplicateComments;
  }
  return meta;
}

function resolveCaptureMode(
  override: SigilContentCaptureMode | undefined,
  env: NodeJS.ProcessEnv,
): SigilContentCaptureMode {
  if (override !== undefined && SIGIL_CAPTURE_MODES.includes(override)) return override;
  const envMode = env.SIGIL_CONTENT_CAPTURE_MODE;
  if (envMode !== undefined && SIGIL_CAPTURE_MODES.includes(envMode as SigilContentCaptureMode)) {
    return envMode as SigilContentCaptureMode;
  }
  return 'metadata_only';
}

function parseModel(model: string): { provider: string; name: string } {
  const idx = model.indexOf('/');
  if (idx === -1) return { provider: '', name: model };
  return { provider: model.slice(0, idx), name: model.slice(idx + 1) };
}

const noop = (): void => undefined;

const SIGIL_PACKAGE = '@grafana/sigil-sdk-js';

async function loadDefaultClient(): Promise<SigilClientType> {
  let mod: { SigilClient: new () => SigilClientType };
  try {
    mod = (await import(SIGIL_PACKAGE)) as typeof mod;
  } catch (cause) {
    throw new Error(
      `Failed to load the bundled ${SIGIL_PACKAGE}. ` +
        `Reinstall @ikko-dev/gitlab-review or pass startSigilBridge({ client }) explicitly.`,
      { cause },
    );
  }
  // SigilClient() reads SIGIL_* env vars automatically from process.env.
  return new mod.SigilClient();
}
