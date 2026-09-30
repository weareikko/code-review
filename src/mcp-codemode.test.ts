import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { CallToolResult, Tool as McpTool } from '@earendil-works/pi-mcp';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeMcpServer } from '../tests/mcp-fake-server.js';
import {
  CODEMODE_TOOL_NAME,
  createMcpCodemodeTool,
  exposeMcpTools,
  type CodemodeCallObserver,
} from './mcp-codemode.js';
import type { McpServerConfig } from './mcp-config.js';
import { connectMcpServers, type McpConnection } from './mcp.js';

const TOOLS: McpTool[] = [
  {
    name: 'get_issue',
    description: 'Read one issue.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_doc',
    description: 'Read one document.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
];

const CONFIG: McpServerConfig = {
  name: 'tracker',
  type: 'stdio',
  command: 'fake-server',
  args: [],
  env: {},
  headers: {},
  source: { kind: 'project', path: '.mcp.json' },
};

const open: McpConnection[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((conn) => conn.close()));
});

async function connect(
  onCall?: (name: string, args: unknown) => CallToolResult | Promise<CallToolResult>,
  callBudget?: number,
) {
  const fake = await startFakeMcpServer({ tools: TOOLS, onCall });
  const conn = await connectMcpServers([CONFIG], {
    createTransport: () => fake.transport,
    callBudget,
  });
  open.push(conn);
  return { fake, conn };
}

function run(tool: AgentTool, code: string, signal?: AbortSignal) {
  return tool.execute('call-1', { code }, signal);
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('createMcpCodemodeTool', () => {
  it('declares the bridged tools in its description', async () => {
    const { conn } = await connect();
    const tool = createMcpCodemodeTool(conn.tools);
    expect(tool.name).toBe(CODEMODE_TOOL_NAME);
    expect(tool.description).toContain('mcp__tracker__get_issue');
    expect(tool.description).toContain('mcp__tracker__get_doc');
    expect(tool.description).toContain('Read one issue.');
  });

  it('runs two tool calls in parallel from one script', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { fake, conn } = await connect(async (name, args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] };
    });
    const tool = createMcpCodemodeTool(conn.tools);

    const result = await run(
      tool,
      `const [a, b] = await Promise.all([
        tools.mcp__tracker__get_issue({ id: '7' }),
        tools.mcp__tracker__get_doc({ slug: 'cap' }),
      ]);
      return a + ' | ' + b;`,
    );

    expect(textOf(result)).toBe('get_issue:{"id":"7"} | get_doc:{"slug":"cap"}');
    expect(fake.calls).toHaveLength(2);
    expect(maxInFlight).toBe(2);
    expect(conn.servers[0]!.calls).toBe(2);
  });

  it('keeps nested results out of the output unless the script returns them', async () => {
    const { conn } = await connect(() => ({
      content: [{ type: 'text', text: 'SECRET ISSUE BODY' }],
    }));
    const tool = createMcpCodemodeTool(conn.tools);

    const result = await run(
      tool,
      `const body = await tools.mcp__tracker__get_issue({ id: '1' });
      return body.length > 0 ? 'found' : 'empty';`,
    );

    expect(textOf(result)).toBe('found');
    expect(textOf(result)).not.toContain('SECRET');
  });

  it('applies the shared call budget to every nested call', async () => {
    const { fake, conn } = await connect(undefined, 1);
    const tool = createMcpCodemodeTool(conn.tools);

    const result = await run(
      tool,
      `const first = await tools.mcp__tracker__get_issue({ id: '1' });
      const second = await tools.mcp__tracker__get_issue({ id: '2' });
      return [first, second];`,
    );

    expect(fake.calls).toHaveLength(1);
    const [first, second] = JSON.parse(textOf(result)) as string[];
    expect(first).toBe('get_issue:{"id":"1"}');
    expect(second).toContain('MCP call budget exhausted (1 calls per review)');
  });

  it('rejects the nested call on an isError result, and throws when the script does not catch it', async () => {
    const { conn } = await connect(() => ({
      content: [{ type: 'text', text: 'issue not found' }],
      isError: true,
    }));
    const tool = createMcpCodemodeTool(conn.tools);

    const caught = await run(
      tool,
      `try { await tools.mcp__tracker__get_issue({ id: '9' }); }
      catch (error) { return 'caught: ' + error.message; }`,
    );
    expect(textOf(caught)).toBe('caught: issue not found');

    await expect(run(tool, `await tools.mcp__tracker__get_issue({ id: '9' });`)).rejects.toThrow(
      /codemode script error: .*issue not found/s,
    );
  });

  it('fails a script that runs past the timeout', async () => {
    const { conn } = await connect();
    const tool = createMcpCodemodeTool(conn.tools, { timeoutMs: 200 });

    await expect(run(tool, 'while (true) {}')).rejects.toThrow(/codemode timeout error/);
  });

  it('forwards the abort signal', async () => {
    const { conn } = await connect(() => new Promise<CallToolResult>(() => {}));
    const tool = createMcpCodemodeTool(conn.tools);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(
      run(tool, `await tools.mcp__tracker__get_issue({ id: '1' });`, controller.signal),
    ).rejects.toThrow(/codemode aborted error/);
  });

  it('caps the script output with the MCP result cap', async () => {
    const { conn } = await connect();
    const tool = createMcpCodemodeTool(conn.tools, { maxResultChars: 100 });

    const result = await run(tool, `return 'x'.repeat(5000);`);

    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text).toContain('[truncated: result was 5000 characters, limit is 100]');
  });

  it('rejects a nested call whose argument is not an object', async () => {
    const { fake, conn } = await connect();
    const tool = createMcpCodemodeTool(conn.tools);

    const result = await run(
      tool,
      `try { await tools.mcp__tracker__get_issue('7'); } catch (error) { return error.message; }`,
    );

    expect(textOf(result)).toBe('mcp__tracker__get_issue expects one object argument');
    expect(fake.calls).toHaveLength(0);
  });

  it('reports each nested call to the observer', async () => {
    const { conn } = await connect((name) =>
      name === 'get_doc'
        ? { content: [{ type: 'text', text: 'boom' }], isError: true }
        : { content: [{ type: 'text', text: 'issue body' }] },
    );
    const events: string[] = [];
    const observer: CodemodeCallObserver = {
      start: (name, args, id) => events.push(`start ${name} ${JSON.stringify(args)} ${id}`),
      end: (name, _result, isError, id) => events.push(`end ${name} ${isError} ${id}`),
    };
    const tool = createMcpCodemodeTool(conn.tools, { observer });

    await run(
      tool,
      `await tools.mcp__tracker__get_issue({ id: '1' });
      try { await tools.mcp__tracker__get_doc({ slug: 'x' }); } catch {}`,
    );

    expect(events).toEqual([
      'start mcp__tracker__get_issue {"id":"1"} codemode-1',
      'end mcp__tracker__get_issue false codemode-1',
      'start mcp__tracker__get_doc {"slug":"x"} codemode-2',
      'end mcp__tracker__get_doc true codemode-2',
    ]);
  });
});

describe('exposeMcpTools', () => {
  it('returns the bridged tools unchanged in direct mode', async () => {
    const { conn } = await connect();
    expect(exposeMcpTools(conn.tools, 'direct')).toEqual(conn.tools);
  });

  it('replaces the bridged tools with one codemode tool in codemode mode', async () => {
    const { conn } = await connect();
    const exposed = exposeMcpTools(conn.tools, 'codemode');
    expect(exposed.map((tool) => tool.name)).toEqual([CODEMODE_TOOL_NAME]);
  });

  it('declares no codemode tool when no MCP tool is connected', () => {
    expect(exposeMcpTools([], 'codemode')).toEqual([]);
  });
});
