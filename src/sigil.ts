/**
 * Optional Grafana AI Observability (Sigil) bridge over `diagnostics_channel`.
 *
 * Subscribes to the `@ikko-dev/gitlab-review:run` tracing channel and
 * forwards generation telemetry to Grafana AI Observability via
 * `@grafana/sigil-sdk-js`.
 *
 * Opt-in: set `GITLAB_REVIEW_SIGIL=1` (or pass `--sigil`). The Sigil client
 * is dynamically loaded only when enabled — omitting the env var costs nothing
 * at startup.
 *
 * `@grafana/sigil-sdk-js` is an **optional peer dependency** and is not
 * bundled with this package. Install it separately when you need Sigil support:
 *
 *   npm install @grafana/sigil-sdk-js
 *
 * Configure the generation endpoint and auth through `SIGIL_*` env vars as
 * shown in Grafana AI Observability → Configuration (e.g. `SIGIL_ENDPOINT`,
 * `SIGIL_AUTH_TENANT_ID`, `SIGIL_AUTH_TOKEN`, …). Unlike `GITLAB_REVIEW_OTEL`
 * (which sends generic OTLP spans and metrics), `GITLAB_REVIEW_SIGIL` sends
 * generation-level records to Grafana AI Observability and is NOT OTLP.
 *
 * Content capture is controlled by `SIGIL_CONTENT_CAPTURE_MODE` (or the
 * `--sigil-capture-mode` CLI flag):
 * - `metadata_only` (default): token counts, costs, model name, timing, and
 *   project/MR identifiers only. No diff, prompt, or review body content.
 * - `no_tool_content` / `full`: accepted at the SDK level; message content is
 *   not yet captured in the diagnostic context so these modes behave like
 *   `metadata_only` in practice. Passing the mode ensures the SDK honours it
 *   if message data is added to diagnostics in a future release.
 *
 * Library callers with a pre-configured `SigilClient` can inject it via
 * `startSigilBridge({ client })` to skip the default client boot and share a
 * single instance. Tests inject fakes with assertion hooks the same way.
 *
 * --- Type note ---
 * The types below are defined inline to avoid requiring `@grafana/sigil-sdk-js`
 * as a hard (dev) dependency. The package brings in many optional framework
 * integrations (LangChain, Google ADK, Strands, …) with transitive peer dep
 * requirements that conflict with this project's `@opentelemetry/*` versions.
 * The inline types are intentionally minimal — only the API surface this bridge
 * actually calls.
 */

import type { SigilContentCaptureMode } from './config.js';
import { SIGIL_CAPTURE_MODES } from './config.js';
import { diagnosticChannels, type DiagnosticContext } from './diagnostics.js';
import type { TurnContentBlock, TurnData, TurnToolResultContent } from './gitlab-review.js';

// Inlined at build time by Vite's `define` (see vite.config.ts). Keeps
// `agentVersion` accurate under `npx`/standalone bin invocations, where
// `npm_package_version` from `npm run` is not set.
declare const __PKG_VERSION__: string;

// ---------------------------------------------------------------------------
// Minimal inline types for the @grafana/sigil-sdk-js API surface we use.
// These are structurally compatible with the real SDK types; the dynamic
// import at runtime provides the actual implementation.
// ---------------------------------------------------------------------------

interface SigilModelRef {
  provider: string;
  name: string;
}

interface SigilTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

interface SigilToolDef {
  name: string;
}

interface SigilGenerationStart {
  id?: string;
  conversationId?: string;
  agentName?: string;
  agentVersion?: string;
  model: SigilModelRef;
  contentCapture?: string;
  thinkingEnabled?: boolean;
  tools?: SigilToolDef[];
  parentGenerationIds?: string[];
  startedAt?: Date;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}

// Sigil output message types — structurally compatible with Message / MessagePart
// in @grafana/sigil-sdk-js. Defined inline to avoid the hard dep.
interface SigilTextPart {
  type: 'text';
  text: string;
}
interface SigilThinkingPart {
  type: 'thinking';
  thinking: string;
}
interface SigilToolCallPart {
  type: 'tool_call';
  toolCall: { id: string; name: string; inputJSON: string };
}
interface SigilToolResultPart {
  type: 'tool_result';
  toolResult: { toolCallId: string; name: string; content: string; isError: boolean };
}
type SigilMessagePart = SigilTextPart | SigilThinkingPart | SigilToolCallPart | SigilToolResultPart;
interface SigilMessage {
  role: 'user' | 'assistant' | 'tool';
  parts: SigilMessagePart[];
}

interface SigilGenerationResult {
  usage?: SigilTokenUsage;
  completedAt?: Date;
  stopReason?: string;
  output?: SigilMessage[];
  metadata?: Record<string, unknown>;
}

interface SigilGenerationRecorder {
  setResult(result: SigilGenerationResult): void;
  setCallError(error: unknown): void;
  setFirstTokenAt(firstTokenAt: Date): void;
  end(): void;
}

interface SigilToolExecutionStart {
  toolName: string;
  toolCallId?: string;
  toolType?: string;
  conversationId?: string;
  agentName?: string;
  agentVersion?: string;
  requestModel?: string;
  requestProvider?: string;
  contentCapture?: string;
  startedAt?: Date;
}

interface SigilToolExecutionRecorder {
  setResult(result: { completedAt?: Date }): void;
  setCallError(error: unknown): void;
  end(): void;
}

/** Minimal interface for the @grafana/sigil-sdk-js SigilClient. */
export interface SigilClientLike {
  startGeneration(start: SigilGenerationStart): SigilGenerationRecorder;
  startStreamingGeneration<T>(
    start: SigilGenerationStart,
    callback: (recorder: SigilGenerationRecorder) => Promise<T>,
  ): Promise<T>;
  startToolExecution(start: SigilToolExecutionStart): SigilToolExecutionRecorder;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SigilBridge {
  shutdown(): Promise<void>;
  /**
   * Creates a per-turn telemetry handler suitable for `RunReviewOptions.onTurnEnd`.
   * The handler emits one `startStreamingGeneration` record per agent turn and one
   * `startToolExecution` span for each tool call within that turn.
   *
   * @param parentGenerationId The ID of the run-level generation (= diagnostics runId)
   *   to link each turn as a child. Pass the same `runId` used when starting the bridge.
   */
  createTurnHandler(parentGenerationId: string): (data: TurnData) => Promise<void>;
}

export interface SigilBridgeOptions {
  /**
   * Pre-wired Sigil client. When provided, the bridge uses the supplied
   * client and skips dynamic import of `@grafana/sigil-sdk-js`. Tests inject
   * fakes with assertion hooks; library callers with an existing client pass
   * it here to share a single instance.
   */
  client?: SigilClientLike;
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
  const client = options.client ?? (await loadDefaultClient());

  const openByRun = new Map<string, SigilGenerationRecorder>();

  const handlers = {
    start: (ctx: DiagnosticContext) => {
      const { provider, name } = parseModel(ctx.model ?? '');
      const recorder = client.startGeneration({
        // Use runId as the generation's explicit ID so per-turn handlers can
        // reference it via parentGenerationIds for dependency linking.
        id: ctx.runId,
        conversationId: ctx.runId,
        agentName: 'gitlab-review',
        agentVersion: __PKG_VERSION__,
        model: {
          provider: provider || 'unknown',
          name: name || ctx.model || 'unknown',
        },
        contentCapture: captureMode,
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
      const result: SigilGenerationResult = {
        completedAt: ctx.completedAt ? new Date(ctx.completedAt) : new Date(),
        metadata: buildResultMetadata(ctx),
      };
      if (ctx.usage) {
        const { input, output, cacheRead, cacheWrite } = ctx.usage.tokens;
        result.usage = {
          inputTokens: input,
          outputTokens: output,
          // totalTokens follows the OTel gen_ai convention: input + output only.
          // Cache tokens are reported separately and must not inflate this field.
          totalTokens: input + output,
          // Only set cache tokens when non-zero to keep the payload clean.
          ...(cacheRead > 0 ? { cacheReadInputTokens: cacheRead } : {}),
          ...(cacheWrite > 0 ? { cacheWriteInputTokens: cacheWrite } : {}),
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

  // Subscribe to the outer `run` channel (not `reviewer.run`) so that asyncEnd
  // fires after all phases complete — including comment parsing and deduplication
  // — giving us `ctx.generated`, `ctx.newComments`, and `ctx.duplicateComments`
  // alongside `ctx.usage`. The `reviewer.run` channel fires too early (before
  // comment counts are populated on the run context).
  diagnosticChannels.run.subscribe(handlers);

  return {
    async shutdown() {
      diagnosticChannels.run.unsubscribe(handlers);
      // End any recorders that were never closed (e.g. process killed mid-run).
      for (const recorder of openByRun.values()) {
        recorder.end();
      }
      openByRun.clear();
      await client.shutdown();
    },

    createTurnHandler(parentGenerationId: string): (data: TurnData) => Promise<void> {
      return async (data: TurnData) => {
        const { provider, name } = parseModel(data.model ?? '');
        // Derive tool definitions from unique tool names actually executed this turn.
        const toolsSeen = new Set<string>();
        const tools: SigilToolDef[] = [];
        for (const t of data.toolTimings) {
          if (!toolsSeen.has(t.toolName)) {
            toolsSeen.add(t.toolName);
            tools.push({ name: t.toolName });
          }
        }
        await client.startStreamingGeneration(
          {
            conversationId: data.conversationId,
            agentName: 'gitlab-review',
            agentVersion: __PKG_VERSION__,
            model: {
              provider: data.provider || provider || 'unknown',
              name: name || data.model || 'unknown',
            },
            contentCapture: captureMode,
            startedAt: data.startedAt,
            thinkingEnabled: data.thinkingEnabled || undefined,
            ...(tools.length > 0 ? { tools } : {}),
            parentGenerationIds: [parentGenerationId],
          },
          async (recorder) => {
            if (data.firstTokenAt) {
              recorder.setFirstTokenAt(data.firstTokenAt);
            }
            // Emit one tool span per tool execution within this turn.
            for (const tool of data.toolTimings) {
              const toolRec = client.startToolExecution({
                toolName: tool.toolName,
                toolCallId: tool.toolCallId,
                toolType: 'function',
                conversationId: data.conversationId,
                agentName: 'gitlab-review',
                agentVersion: __PKG_VERSION__,
                requestModel: data.model,
                requestProvider: data.provider,
                contentCapture: captureMode,
                startedAt: tool.startedAt,
              });
              if (tool.isError) {
                toolRec.setCallError(new Error(`tool ${tool.toolName} failed`));
              } else {
                toolRec.setResult({ completedAt: tool.completedAt });
              }
              toolRec.end();
            }
            const { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens } =
              data.usage;
            const output = buildOutputMessages(
              data.contentBlocks,
              data.toolResultContents,
              captureMode,
            );
            recorder.setResult({
              completedAt: data.completedAt,
              stopReason: mapTurnStopReason(data.stopReason),
              usage: {
                inputTokens,
                outputTokens,
                // totalTokens follows the OTel gen_ai convention: input + output only.
                totalTokens: inputTokens + outputTokens,
                ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
                ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}),
              },
              ...(output ? { output } : {}),
            });
          },
        );
      };
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

/**
 * Normalise pi stop-reason strings to the Sigil/OTel gen_ai convention.
 * Mirrors mappers.ts in @grafana/sigil-pi.
 */
function mapTurnStopReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'toolUse':
    case 'tool_use':
      return 'tool_use';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
    default:
      return reason;
  }
}

/**
 * Serialise per-turn content blocks and tool results to the Sigil Message format.
 *
 * Mirrors the logic in @grafana/sigil-pi `mappers.ts`:
 * - `metadata_only`: returns undefined (no message bodies exported).
 * - `no_tool_content`: includes assistant text/thinking but omits tool call args
 *   and tool result bodies.
 * - `full`: everything included.
 *
 * Tool call and tool result parts are always emitted (structure needed for the
 * SDK's tool_calls_per_operation metric); bodies are conditionally included.
 */
function buildOutputMessages(
  contentBlocks: TurnContentBlock[],
  toolResultContents: TurnToolResultContent[],
  captureMode: SigilContentCaptureMode,
): SigilMessage[] | undefined {
  if (captureMode === 'metadata_only') return undefined;

  const messages: SigilMessage[] = [];
  const includeBodies = true; // captureMode is no_tool_content or full
  const includeToolBodies = captureMode === 'full';

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      if (includeBodies && block.text.trim().length > 0) {
        messages.push({ role: 'assistant', parts: [{ type: 'text', text: block.text }] });
      }
    } else if (block.type === 'thinking') {
      if (block.redacted) continue;
      if (includeBodies && block.thinking.trim().length > 0) {
        messages.push({
          role: 'assistant',
          parts: [{ type: 'thinking', thinking: block.thinking }],
        });
      }
    } else {
      // toolCall — always emit structure; inputJSON only in full mode
      messages.push({
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            toolCall: {
              id: block.id,
              name: block.name,
              inputJSON: includeToolBodies ? JSON.stringify(block.arguments) : '',
            },
          },
        ],
      });
    }
  }

  for (const tr of toolResultContents) {
    messages.push({
      role: 'tool',
      parts: [
        {
          type: 'tool_result',
          toolResult: {
            toolCallId: tr.toolCallId,
            name: tr.toolName,
            content: includeToolBodies ? tr.content : '',
            isError: tr.isError,
          },
        },
      ],
    });
  }

  return messages.length > 0 ? messages : undefined;
}

const noop = (): void => undefined;

const SIGIL_PACKAGE = '@grafana/sigil-sdk-js';

async function loadDefaultClient(): Promise<SigilClientLike> {
  let mod: { SigilClient: new () => SigilClientLike };
  try {
    mod = (await import(SIGIL_PACKAGE)) as typeof mod;
  } catch (cause) {
    throw new Error(
      `@grafana/sigil-sdk-js is not installed. ` +
        `Run: npm install @grafana/sigil-sdk-js\n` +
        `Or pass startSigilBridge({ client }) to inject a pre-configured client.`,
      { cause },
    );
  }
  // SigilClient() reads SIGIL_* env vars automatically from process.env.
  return new mod.SigilClient();
}
