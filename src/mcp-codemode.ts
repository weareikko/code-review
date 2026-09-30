/**
 * Codemode exposure for bridged MCP tools.
 *
 * Instead of declaring every `mcp__<server>__<tool>` to the model, the reviewer
 * gets one `codemode` tool: it runs a model-written JavaScript script in a
 * QuickJS sandbox (`@earendil-works/pi-codemode`) whose only capability is
 * calling those same bridged tools. Nested results stay out of the model
 * context unless the script returns or prints them.
 *
 * Every nested call goes through the bridged tool's own `execute`, so the
 * read-only gate, the per-review call budget, the `mcp.call` diagnostics trace
 * and the per-call result cap apply unchanged. The script output the model
 * receives is capped with the same rule as a direct call (`formatMcpToolResult`).
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  CodemodeSandbox,
  renderDeclarations,
  type CodemodeJsonSchema,
  type CodemodeResult,
  type CodemodeTool,
} from '@earendil-works/pi-codemode';
import { Type, type Static } from 'typebox';
import { DEFAULT_MCP_MAX_RESULT_CHARS, formatMcpToolResult } from './mcp.js';

/** How the bridged MCP tools reach the reviewer model. */
export type McpExposure = 'direct' | 'codemode';

export const CODEMODE_TOOL_NAME = 'codemode';
/** Deadline for one script, time spent in nested MCP calls included. */
export const DEFAULT_CODEMODE_TIMEOUT_MS = 60_000;
/** Heap cap for the QuickJS VM of one script. */
export const DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

/** Receives every nested call, e.g. the collector that replays MCP results to Verify. */
export interface CodemodeCallObserver {
  start(toolName: string, args: unknown, toolCallId: string): void;
  end(toolName: string, result: unknown, isError: boolean, toolCallId: string): void;
}

export interface McpCodemodeToolOptions {
  /** Cap on the script output returned to the model. Default: the direct MCP result cap. */
  maxResultChars?: number;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  observer?: CodemodeCallObserver;
}

const parameters = Type.Object({
  code: Type.String({
    description:
      'Body of an async JavaScript function. Call tools as `await tools.<name>(args)`; return a value or print with text().',
  }),
});

const USAGE = [
  'Run a JavaScript script that calls the connected read-only MCP tools, and get back only what the script returns or prints.',
  'The code is the body of an async function: use `await tools.<name>(args)`, `Promise.all` for independent lookups, and `return` or `text(value)` for the result. Each tool resolves to the text it returned and rejects with an Error when the call fails.',
  'Nested results do not reach you unless the script returns or prints them, so extract only the parts the review needs. No network, timers, or modules are available; every tool call counts against the MCP call budget.',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text a bridged tool returned, as the script sees it. Images become a short note. */
function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .map((block) =>
      block.type === 'text' ? block.text : `[image omitted: ${block.data.length} bytes]`,
    )
    .join('\n');
}

function toSandboxTool(
  tool: AgentTool,
  nextId: () => string,
  observer: CodemodeCallObserver | undefined,
): CodemodeTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as CodemodeJsonSchema,
    outputSchema: { type: 'string' },
    async execute(args, { signal }) {
      // The agent validates direct calls against the schema; a script can pass
      // anything, and an MCP `tools/call` needs an arguments object.
      const params = args === undefined ? {} : args;
      if (!isRecord(params)) throw new Error(`${tool.name} expects one object argument`);
      const id = nextId();
      observer?.start(tool.name, params, id);
      try {
        const result = await tool.execute(id, params as never, signal);
        observer?.end(tool.name, result, false, id);
        return resultText(result);
      } catch (error) {
        observer?.end(tool.name, undefined, true, id);
        throw error;
      }
    },
  };
}

/** Model-visible content of one script run, before the result cap. */
function scriptContent(result: CodemodeResult): unknown[] {
  const content: unknown[] = [...result.output];
  if (result.ok) {
    if (result.value !== undefined) {
      const text =
        typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2);
      content.push({ type: 'text', text });
    }
    if (content.length === 0) content.push({ type: 'text', text: '(no output)' });
  } else {
    const detail = result.error.stack ?? result.error.message;
    content.push({ type: 'text', text: `codemode ${result.error.kind} error: ${detail}` });
  }
  return content;
}

/**
 * Wrap the bridged MCP tools in one `codemode` agent tool. Each call runs in a
 * fresh sandbox, closed afterwards. A failed script throws its capped output
 * plus the error, so the agent loop records an error tool result.
 */
export function createMcpCodemodeTool(
  mcpTools: readonly AgentTool[],
  options: McpCodemodeToolOptions = {},
): AgentTool {
  const {
    maxResultChars = DEFAULT_MCP_MAX_RESULT_CHARS,
    timeoutMs = DEFAULT_CODEMODE_TIMEOUT_MS,
    memoryLimitBytes = DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES,
    observer,
  } = options;
  // Nested ids only need to be unique for the observer; a shared counter keeps
  // concurrent scripts (the full-depth angle finders) apart.
  let sequence = 0;
  const nextId = () => `codemode-${++sequence}`;
  const sandboxTools = mcpTools.map((tool) => toSandboxTool(tool, nextId, observer));

  const tool: AgentTool<typeof parameters, undefined> = {
    name: CODEMODE_TOOL_NAME,
    label: 'MCP codemode',
    description: `${USAGE}\n\n${renderDeclarations({ tools: sandboxTools })}`,
    parameters,
    async execute(_id, { code }: Static<typeof parameters>, signal) {
      const sandbox = new CodemodeSandbox({ tools: sandboxTools, timeoutMs, memoryLimitBytes });
      try {
        const result = await sandbox.execute(code, { signal });
        // Same cap as a direct call; with `isError` it throws the capped text.
        const content = formatMcpToolResult(
          { content: scriptContent(result) as never, isError: !result.ok },
          maxResultChars,
        );
        return { content, details: undefined };
      } finally {
        await sandbox.close();
      }
    },
  };
  return tool as unknown as AgentTool;
}

/**
 * The MCP tools to declare to the model for the chosen exposure: the bridged
 * tools as they are (`direct`), or one `codemode` tool wrapping them — none
 * when no MCP tool is connected.
 */
export function exposeMcpTools(
  mcpTools: readonly AgentTool[],
  exposure: McpExposure,
  options: McpCodemodeToolOptions = {},
): AgentTool[] {
  if (exposure === 'direct') return [...mcpTools];
  return mcpTools.length > 0 ? [createMcpCodemodeTool(mcpTools, options)] : [];
}
