/**
 * MCP client bridge for the reviewer agent.
 *
 * Connects the servers described by `McpServerConfig` (see `mcp-config.ts`),
 * lists their tools, keeps only the read-only ones, and wraps each as a pi
 * `AgentTool` named `mcp__<server>__<tool>`. The bridge enforces a per-call
 * timeout, a result size cap, and a per-review call budget shared by every MCP
 * tool. A server that fails to connect is reported as `unavailable` and never
 * aborts the review.
 *
 * The reviewer processes attacker-controlled MR content, so only tools that
 * declare themselves read-only (`annotations.readOnlyHint === true` and not
 * `destructiveHint`) are exposed.
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { TSchema } from 'typebox';
import {
  traceMcpDiagnostic,
  type McpDiagnosticContext,
  type McpDiagnosticOp,
} from './diagnostics.js';
import { noopLogger, type Logger } from './logger.js';
import type { McpServerConfig, McpServerSource } from './mcp-config.js';
import { PRODUCT_NAME } from './product.js';
import { redactUrl } from './skills.js';

declare const __PKG_VERSION__: string;

/** Default per-call timeout. A server config may lower or raise it, up to `MAX_MCP_TIMEOUT_MS`. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
/**
 * Timeout for connect and `tools/list`. Deliberately not overridable by a server
 * definition: both run before the agent loop starts, so they are outside the
 * review timeout and a large per-server `timeout` must not stall the pipeline.
 */
export const MCP_CONNECT_TIMEOUT_MS = 30_000;
/** Default number of MCP tool calls allowed per review, across all servers. */
export const DEFAULT_MCP_CALL_BUDGET = 40;
/** Default cap on the content returned by one MCP tool call, text and image bytes together. */
export const DEFAULT_MCP_MAX_RESULT_CHARS = 200_000;
/** Cap on image blocks kept from one MCP tool call, whatever the size budget allows. */
export const MAX_MCP_IMAGE_BLOCKS = 4;

/** Connection outcome for one configured server, rendered in the summary footer. */
export interface McpServerStatus {
  name: string;
  source: McpServerSource;
  status: 'connected' | 'unavailable';
  /** Original (server-side) names of the tools exposed to the reviewer. */
  tools: string[];
  /** Calls made during the review. Updated in place by the bridge. */
  calls: number;
}

export interface ConnectMcpServersOptions {
  logger?: Logger;
  /** Per-call timeout when the server config does not set one. */
  timeoutMs?: number;
  /** Total MCP calls allowed per review, across every server and tool. */
  callBudget?: number;
  /** Cap on the text returned by one call; longer results are truncated. */
  maxResultChars?: number;
  /** Test seam: build the transport for a config instead of the real one. */
  createTransport?: (config: McpServerConfig) => Transport;
  /**
   * The enclosing review's diagnostic run id. When set, connect/list-tools/call
   * are traced on the `mcp.connect` / `mcp.tools` / `mcp.call` diagnostics
   * channels (see `src/diagnostics.ts`); omitted (e.g. ad hoc library use, most
   * tests) means no diagnostics events are published.
   */
  runId?: string;
}

export interface McpConnection {
  tools: AgentTool[];
  servers: McpServerStatus[];
  /** Close every connected client. Safe to call more than once. */
  close(): Promise<void>;
}

/** Only tools that declare themselves read-only and non-destructive are exposed. */
export function isReadOnlyMcpTool(tool: Pick<McpTool, 'annotations'>): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** `mcp__<server>__<tool>`, with characters outside `[A-Za-z0-9_-]` replaced. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${safeSegment(server)}__${safeSegment(tool)}`;
}

/** Build the real transport for a server config. */
export function createMcpTransport(config: McpServerConfig): Transport {
  switch (config.type) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command as string,
        args: config.args,
        // Only the SDK's safe subset of the parent environment is inherited;
        // anything a server needs must be passed explicitly through `env`.
        env: { ...getDefaultEnvironment(), ...config.env },
        stderr: 'ignore',
      });
    case 'http':
      return new StreamableHTTPClientTransport(new URL(config.url as string), {
        requestInit: { headers: config.headers },
      });
    case 'sse':
      // Deprecated upstream in favour of streamable HTTP, but still what many
      // hosted servers speak; the config layer maps `type: sse` here on purpose.
      // oxlint-disable-next-line typescript/no-deprecated
      return new SSEClientTransport(new URL(config.url as string), {
        requestInit: { headers: config.headers },
      });
    default:
      throw new Error(`Unsupported MCP transport: ${String(config.type)}`);
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactUrl(message);
}

/**
 * Runs `operation` traced on the given MCP diagnostics channel when `runId` is
 * set, or plain when it isn't (no channel publish). Keeps `connectOne` and
 * `bridgeTool` free of `if (runId) { traced } else { plain }` branching at
 * every call site.
 */
function withMcpTrace<T>(
  runId: string | undefined,
  op: McpDiagnosticOp,
  server: string,
  operation: (context?: McpDiagnosticContext) => Promise<T>,
): Promise<T> {
  return runId ? traceMcpDiagnostic(op, runId, server, operation) : operation();
}

/**
 * Convert an MCP `tools/call` result into pi tool content. Text-like blocks are
 * joined into one text block; images follow. Server output is untrusted and
 * unbounded, so `maxChars` caps the whole result — the joined text first, then
 * each image's base64 payload against what the text left — and at most
 * `MAX_MCP_IMAGE_BLOCKS` images survive. Dropped images leave a note in the text
 * so the agent knows something was there. The cap applies on the error path too:
 * a result the server flagged as an error throws the same capped text, so the
 * agent loop records a bounded error tool result.
 */
export function formatMcpToolResult(
  result: CallToolResult,
  maxChars: number,
): (TextContent | ImageContent)[] {
  const texts: string[] = [];
  const images: ImageContent[] = [];
  for (const block of result.content) {
    switch (block.type) {
      case 'text':
        texts.push(block.text);
        break;
      case 'image':
        images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
        break;
      case 'resource':
        if ('text' in block.resource) {
          texts.push(block.resource.text);
        } else {
          texts.push(`[binary resource ${block.resource.uri} omitted]`);
        }
        break;
      case 'resource_link':
        texts.push(
          `[resource link] ${block.uri}${block.description ? ` — ${block.description}` : ''}`,
        );
        break;
      default:
        texts.push(`[${block.type} content omitted]`);
    }
  }
  if (texts.length === 0 && result.structuredContent !== undefined) {
    texts.push(JSON.stringify(result.structuredContent));
  }

  let text = texts.join('\n');
  if (text.length > maxChars) {
    // The notice lives inside the cap, so the returned text never exceeds
    // `maxChars`; a cap smaller than the notice yields the notice alone.
    const notice = `\n\n[truncated: result was ${text.length} characters, limit is ${maxChars}]`;
    text = `${text.slice(0, Math.max(0, maxChars - notice.length))}${notice}`;
  }
  if (result.isError) {
    throw new Error(text || 'MCP tool returned an error');
  }

  // Images count against what the text left of the same budget, so a server
  // cannot bypass the cap by returning megabytes of base64 instead of text.
  let remaining = Math.max(0, maxChars - text.length);
  const kept: ImageContent[] = [];
  const notes: string[] = [];
  for (const image of images) {
    if (kept.length >= MAX_MCP_IMAGE_BLOCKS || image.data.length > remaining) {
      notes.push(`[image omitted: ${image.data.length} bytes]`);
      continue;
    }
    remaining -= image.data.length;
    kept.push(image);
  }
  if (notes.length > 0) {
    text = text.length > 0 ? `${text}\n${notes.join('\n')}` : notes.join('\n');
  }

  const content: (TextContent | ImageContent)[] = [];
  if (text.length > 0 || kept.length === 0) content.push({ type: 'text', text });
  content.push(...kept);
  return content;
}

function toParameters(tool: McpTool): TSchema {
  const schema = { ...tool.inputSchema } as Record<string, unknown>;
  if (schema.type !== 'object') schema.type = 'object';
  if (typeof schema.properties !== 'object' || schema.properties === null) schema.properties = {};
  return schema as unknown as TSchema;
}

interface Budget {
  remaining: number;
  total: number;
}

interface BridgeDeps {
  client: Client;
  status: McpServerStatus;
  budget: Budget;
  timeoutMs: number;
  maxResultChars: number;
  runId?: string;
}

function bridgeTool(tool: McpTool, deps: BridgeDeps): AgentTool {
  const { client, status, budget, timeoutMs, maxResultChars, runId } = deps;
  const bridged: AgentTool<TSchema, undefined> = {
    name: mcpToolName(status.name, tool.name),
    label: `${status.name}: ${tool.name}`,
    description: tool.description ?? `${tool.name} from MCP server ${status.name}`,
    parameters: toParameters(tool),
    async execute(_id, params, signal): Promise<AgentToolResult<undefined>> {
      if (budget.remaining <= 0) {
        return {
          content: [
            {
              type: 'text',
              text: `MCP call budget exhausted (${budget.total} calls per review). Do not call MCP tools again; continue the review with the information you already have.`,
            },
          ],
          details: undefined,
        };
      }
      budget.remaining -= 1;
      status.calls += 1;
      return withMcpTrace(runId, 'mcp.call', status.name, async (context) => {
        if (context) context.tool = tool.name;
        const result = await client.callTool(
          { name: tool.name, arguments: params as Record<string, unknown> },
          undefined,
          { timeout: timeoutMs, signal },
        );
        const content = formatMcpToolResult(result as CallToolResult, maxResultChars);
        if (context) {
          context.resultChars = content.reduce(
            (chars, block) => chars + (block.type === 'text' ? block.text.length : 0),
            0,
          );
        }
        return { content, details: undefined };
      });
    },
  };
  return bridged as AgentTool;
}

/**
 * `Client.listTools` caches each tool's output-schema validator and task-support
 * flags, and clears that cache at the start of every call — so after paginating,
 * the client only holds metadata for the last page and `callTool` silently skips
 * output validation for every tool listed before it. The SDK exposes no public
 * re-prime, so re-seed the cache with the full set through its (typed-private,
 * runtime-public) `cacheToolMetadata`, guarded so a future SDK that drops it
 * degrades to today's single-page behaviour instead of throwing.
 */
function recacheToolMetadata(client: Client, tools: readonly McpTool[]): void {
  const recache = (client as unknown as { cacheToolMetadata?: (tools: readonly McpTool[]) => void })
    .cacheToolMetadata;
  if (typeof recache === 'function') recache.call(client, tools);
}

async function listAllTools(client: Client, timeoutMs: number): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  if (pages > 1) recacheToolMetadata(client, tools);
  return tools;
}

interface ConnectedServer {
  client: Client;
  status: McpServerStatus;
  tools: AgentTool[];
}

async function connectOne(
  config: McpServerConfig,
  options: Required<Omit<ConnectMcpServersOptions, 'createTransport' | 'runId'>> & {
    createTransport: (config: McpServerConfig) => Transport;
    budget: Budget;
    runId?: string;
  },
): Promise<ConnectedServer> {
  const { logger, budget, maxResultChars, runId } = options;
  // Per-call timeout may come from the server config (already clamped by the
  // parser); connect and tools/list keep the fixed timeout — see
  // `MCP_CONNECT_TIMEOUT_MS`.
  const timeoutMs = config.timeoutMs ?? options.timeoutMs;
  const status: McpServerStatus = {
    name: config.name,
    source: config.source,
    status: 'unavailable',
    tools: [],
    calls: 0,
  };
  const client = new Client({ name: PRODUCT_NAME, version: __PKG_VERSION__ });
  try {
    await withMcpTrace(runId, 'mcp.connect', config.name, () =>
      client.connect(options.createTransport(config), { timeout: MCP_CONNECT_TIMEOUT_MS }),
    );
    const { exposed, dropped } = await withMcpTrace(
      runId,
      'mcp.tools',
      config.name,
      async (context) => {
        const listed = await listAllTools(client, MCP_CONNECT_TIMEOUT_MS);
        const readOnly = listed.filter(isReadOnlyMcpTool);
        const notReadOnly = listed.filter((tool) => !isReadOnlyMcpTool(tool));
        if (context) context.toolCount = readOnly.length;
        return { exposed: readOnly, dropped: notReadOnly };
      },
    );
    if (dropped.length > 0) {
      logger.debug(
        `MCP server "${config.name}": dropped ${dropped.length} tool(s) without readOnlyHint: ${dropped.map((t) => t.name).join(', ')}`,
      );
    }
    status.status = 'connected';
    status.tools = exposed.map((tool) => tool.name);
    logger.info(
      `MCP server "${config.name}" connected: ${exposed.length} read-only tool(s) exposed.`,
    );
    return {
      client,
      status,
      tools: exposed.map((tool) =>
        bridgeTool(tool, { client, status, budget, timeoutMs, maxResultChars, runId }),
      ),
    };
  } catch (error) {
    logger.warn(`MCP server "${config.name}" unavailable: ${errorMessage(error)}`);
    await client.close().catch(() => {});
    return { client, status, tools: [] };
  }
}

/**
 * Connect every configured server, list its tools, and bridge the read-only
 * ones. Never throws for a server failure: the server is reported as
 * `unavailable` and the review continues with the others.
 */
export async function connectMcpServers(
  configs: readonly McpServerConfig[],
  options: ConnectMcpServersOptions = {},
): Promise<McpConnection> {
  const total = options.callBudget ?? DEFAULT_MCP_CALL_BUDGET;
  const resolved = {
    logger: options.logger ?? noopLogger,
    timeoutMs: options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    callBudget: total,
    maxResultChars: options.maxResultChars ?? DEFAULT_MCP_MAX_RESULT_CHARS,
    createTransport: options.createTransport ?? createMcpTransport,
    budget: { remaining: total, total },
    runId: options.runId,
  };
  const connected = await Promise.all(configs.map((config) => connectOne(config, resolved)));

  // `mcpToolName` sanitises both segments, so two distinct servers (`jira.internal`
  // and `jira_internal`, say) can produce the same bridged name — which would let
  // a lower-trust server shadow a trusted one in the agent's tool dispatch. First
  // one wins; a later collision is dropped with a warning and removed from the
  // server's exposed-tool list so the summary footer stays truthful.
  const emitted = new Set<string>();
  const tools: AgentTool[] = [];
  for (const server of connected) {
    for (const tool of server.tools) {
      if (emitted.has(tool.name)) {
        resolved.logger.warn(
          `MCP server "${server.status.name}": tool "${tool.name}" collides with an already-bridged tool name — dropped.`,
        );
        const index = server.status.tools.findIndex(
          (name) => mcpToolName(server.status.name, name) === tool.name,
        );
        if (index !== -1) server.status.tools.splice(index, 1);
        continue;
      }
      emitted.add(tool.name);
      tools.push(tool);
    }
  }

  let closed = false;
  return {
    tools,
    servers: connected.map((server) => server.status),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(
        connected
          .filter((server) => server.status.status === 'connected')
          .map((server) => server.client.close().catch(() => {})),
      );
    },
  };
}
