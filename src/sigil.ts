/**
 * Optional Grafana AI Observability (Sigil) bridge via `@grafana/sigil-pi`.
 *
 * Loads `@grafana/sigil-pi` as an extension and subscribes it to the
 * pi agent's event stream so every turn is exported to Grafana AI Observability
 * automatically — without maintaining custom Sigil orchestration.
 *
 * Opt-in: set `GITLAB_REVIEW_SIGIL=1` (or pass `--sigil`). The bridge is
 * dynamically loaded only when enabled — omitting the env var costs nothing.
 *
 * Configure the Sigil endpoint and auth through `SIGIL_*` env vars as
 * shown in Grafana AI Observability → Configuration (e.g. `SIGIL_ENDPOINT`,
 * `SIGIL_AUTH_TENANT_ID`, `SIGIL_AUTH_TOKEN`, …).
 *
 * Content capture is controlled by `SIGIL_CONTENT_CAPTURE_MODE` (or the
 * `--sigil-capture-mode` CLI flag):
 * - `metadata_only` (default): token counts, costs, model name, timing only.
 * - `no_tool_content`: adds assistant text/thinking, omits tool args/results.
 * - `full`: everything included.
 *
 * @grafana/sigil-pi is an **optional peer dependency** and is not bundled with
 * this package. Install it separately when you need Sigil support:
 *
 *   npm install @grafana/sigil-pi
 */

import type { SigilContentCaptureMode } from './config.js';
import { SIGIL_CAPTURE_MODES } from './config.js';
import type { AgentLike } from './gitlab-review.js';

// Inlined at build time by Vite's `define` (see vite.config.ts).
declare const __PKG_VERSION__: string;

// ---------------------------------------------------------------------------
// Minimal event bus — only implements the `.on()` method that sigil-pi calls
// on the ExtensionAPI it receives. Everything else is deliberately absent; the
// factory function only ever calls `pi.on(event, handler)`.
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown, ctx: unknown) => void | Promise<void>;

function createMinimalEventBus() {
  const handlers = new Map<string, EventHandler[]>();
  return {
    on(event: string, handler: EventHandler): void {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    async dispatch(event: string, data: unknown, ctx: unknown): Promise<void> {
      for (const h of handlers.get(event) ?? []) {
        try {
          await h(data, ctx);
        } catch (err) {
          // Telemetry failures must not surface to the caller.
          console.warn(`[gitlab-review] sigil-pi handler for "${event}" failed:`, err);
        }
      }
    },
  };
}

type MinimalEventBus = ReturnType<typeof createMinimalEventBus>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SigilBridge {
  /**
   * Subscribe to an agent's events and forward them to sigil-pi in real time.
   * Returns an unsubscribe function — call it after the review completes.
   * Must be called before `agent.prompt()` so turn_start and TTFT events fire
   * before any telemetry is emitted.
   */
  subscribeToAgent(agent: AgentLike, conversationId: string | undefined): () => void;
  shutdown(): Promise<void>;
}

export interface SigilBridgeOptions {
  /**
   * Override the env source used for the opt-in check (`GITLAB_REVIEW_SIGIL`).
   * Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Content capture mode override. When supplied, injects
   * `SIGIL_CONTENT_CAPTURE_MODE` into `process.env` before sigil-pi reads it,
   * unless the env var is already set. Defaults to `metadata_only` via sigil-pi.
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

  // Set agent identity env vars before sigil-pi's session_start reads them via
  // loadConfig(). Only inject defaults — user-set values take precedence.
  if (!process.env.SIGIL_AGENT_NAME) process.env.SIGIL_AGENT_NAME = 'gitlab-review';
  if (!process.env.SIGIL_AGENT_VERSION) process.env.SIGIL_AGENT_VERSION = __PKG_VERSION__;

  // Inject the capture mode from the CLI flag if the env var is not already set.
  if (
    options.captureMode !== undefined &&
    SIGIL_CAPTURE_MODES.includes(options.captureMode) &&
    !process.env.SIGIL_CONTENT_CAPTURE_MODE
  ) {
    process.env.SIGIL_CONTENT_CAPTURE_MODE = options.captureMode;
  }

  // Dynamically load @grafana/sigil-pi. This package is an optional peer dep;
  // if it is not installed the bridge silently disables itself.
  let sigilPiMod: { default: (pi: MinimalEventBus) => void | Promise<void> };
  try {
    sigilPiMod = await import('@grafana/sigil-pi');
    if (typeof sigilPiMod.default !== 'function') {
      console.warn('[gitlab-review] @grafana/sigil-pi: default export is not a function');
      return null;
    }
  } catch (err) {
    console.warn(
      '[gitlab-review] @grafana/sigil-pi is not installed. ' +
        'Install it with: npm install @grafana/sigil-pi',
      err,
    );
    return null;
  }

  const bus = createMinimalEventBus();
  // Register all sigil-pi event handlers onto our minimal bus.
  await sigilPiMod.default(bus);

  // A context that satisfies sigil-pi's internal ctx.sessionManager.getSessionId()
  // call used to read the conversationId.
  const noctx = makeCtx(undefined);

  // session_start triggers sigil-pi to load its config and create a SigilClient.
  await bus.dispatch('session_start', { type: 'session_start' }, noctx);

  return {
    subscribeToAgent(agent: AgentLike, conversationId: string | undefined): () => void {
      const ctx = makeCtx(conversationId);
      return agent.subscribe(async (event) => {
        const type = (event as { type?: string }).type;
        if (type) await bus.dispatch(type, event, ctx);
      });
    },

    async shutdown(): Promise<void> {
      await bus.dispatch('session_shutdown', { type: 'session_shutdown' }, noctx);
    },
  };
}

function makeCtx(sessionId: string | undefined) {
  return {
    sessionManager: { getSessionId: (): string | undefined => sessionId },
  };
}
