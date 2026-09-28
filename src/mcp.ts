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
import { noopLogger, type Logger } from './logger.js';
import type { McpServerConfig, McpServerSource } from './mcp-config.js';
import { PRODUCT_NAME } from './product.js';
import { redactUrl } from './skills.js';

declare const __PKG_VERSION__: string;

/** Default per-call timeout, also used for connect and tools/list. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
/** Default number of MCP tool calls allowed per review, across all servers. */
export const DEFAULT_MCP_CALL_BUDGET = 40;
/** Default cap on the text returned by one MCP tool call. */
export const DEFAULT_MCP_MAX_RESULT_CHARS = 200_000;

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
 * Convert an MCP `tools/call` result into pi tool content. Text-like blocks are
 * joined into one text block and capped at `maxChars`; images are passed
 * through. Throws when the server flagged the result as an error so the agent
 * loop records an error tool result.
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
  if (result.isError) {
    throw new Error(text || 'MCP tool returned an error');
  }
  if (text.length > maxChars) {
    const total = text.length;
    text = `${text.slice(0, maxChars)}\n\n[truncated: result was ${total} characters, limit is ${maxChars}]`;
  }

  const content: (TextContent | ImageContent)[] = [];
  if (text.length > 0 || images.length === 0) content.push({ type: 'text', text });
  content.push(...images);
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
}

function bridgeTool(tool: McpTool, deps: BridgeDeps): AgentTool {
  const { client, status, budget, timeoutMs, maxResultChars } = deps;
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
      const result = await client.callTool(
        { name: tool.name, arguments: params as Record<string, unknown> },
        undefined,
        { timeout: timeoutMs, signal },
      );
      return {
        content: formatMcpToolResult(result as CallToolResult, maxResultChars),
        details: undefined,
      };
    },
  };
  return bridged as AgentTool;
}

async function listAllTools(client: Client, timeoutMs: number): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

interface ConnectedServer {
  client: Client;
  status: McpServerStatus;
  tools: AgentTool[];
}

async function connectOne(
  config: McpServerConfig,
  options: Required<Omit<ConnectMcpServersOptions, 'createTransport'>> & {
    createTransport: (config: McpServerConfig) => Transport;
    budget: Budget;
  },
): Promise<ConnectedServer> {
  const { logger, budget, maxResultChars } = options;
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
    await client.connect(options.createTransport(config), { timeout: timeoutMs });
    const listed = await listAllTools(client, timeoutMs);
    const exposed = listed.filter(isReadOnlyMcpTool);
    const dropped = listed.filter((tool) => !isReadOnlyMcpTool(tool));
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
        bridgeTool(tool, { client, status, budget, timeoutMs, maxResultChars }),
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
  };
  const connected = await Promise.all(configs.map((config) => connectOne(config, resolved)));

  let closed = false;
  return {
    tools: connected.flatMap((server) => server.tools),
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
