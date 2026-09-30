import {
  StdioTransport,
  StreamableHttpTransport,
  type CallToolResult,
  type Tool as McpTool,
} from '@earendil-works/pi-mcp';
import { describe, expect, it, vi } from 'vitest';
import { startFakeMcpServer, type FakeMcpServer } from '../tests/mcp-fake-server.js';
import { mcpDiagnosticChannels, type McpDiagnosticContext } from './diagnostics.js';
import type { Logger } from './logger.js';
import type { McpServerConfig } from './mcp-config.js';
import {
  connectMcpServers,
  createMcpTransport,
  formatMcpToolResult,
  inheritedMcpEnvironment,
  isReadOnlyMcpTool,
  MAX_MCP_IMAGE_BLOCKS,
  mcpToolName,
} from './mcp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOLS: McpTool[] = [
  {
    name: 'get_issue',
    description: 'Read one issue.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search',
    description: 'No annotations at all.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_issue',
    description: 'Read-only but destructive (contradictory, must be dropped).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: true },
  },
];

function startFakeServer(
  respond?: (name: string, args: unknown) => CallToolResult | Promise<CallToolResult>,
  pageSize?: number,
): Promise<FakeMcpServer> {
  return startFakeMcpServer({ tools: TOOLS, onCall: respond, pageSize });
}

function config(name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    type: 'stdio',
    command: 'fake-server',
    args: [],
    env: {},
    headers: {},
    source: { kind: 'project', path: '.mcp.json' },
    ...overrides,
  };
}

function captureLogger(): Logger & { lines: Record<string, string[]> } {
  const lines: Record<string, string[]> = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(m),
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
  };
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('isReadOnlyMcpTool', () => {
  it('requires readOnlyHint and rejects destructiveHint', () => {
    expect(isReadOnlyMcpTool({ annotations: { readOnlyHint: true } })).toBe(true);
    expect(isReadOnlyMcpTool({ annotations: { readOnlyHint: true, destructiveHint: false } })).toBe(
      true,
    );
    expect(isReadOnlyMcpTool({ annotations: { readOnlyHint: true, destructiveHint: true } })).toBe(
      false,
    );
    expect(isReadOnlyMcpTool({ annotations: { readOnlyHint: false } })).toBe(false);
    expect(isReadOnlyMcpTool({})).toBe(false);
  });
});

describe('mcpToolName', () => {
  it('joins server and tool with the mcp__ prefix', () => {
    expect(mcpToolName('gitlab', 'get_issue')).toBe('mcp__gitlab__get_issue');
  });

  it('replaces characters outside [A-Za-z0-9_-]', () => {
    expect(mcpToolName('my server.v2', 'do:it')).toBe('mcp__my_server_v2__do_it');
  });
});

describe('formatMcpToolResult', () => {
  it('joins text blocks and passes images through', () => {
    const content = formatMcpToolResult(
      {
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'b' },
        ],
      },
      1000,
    );
    expect(content).toEqual([
      { type: 'text', text: 'a\nb' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  it('falls back to structuredContent when there is no text', () => {
    const content = formatMcpToolResult({ content: [], structuredContent: { ok: true } }, 1000);
    expect(content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
  });

  it('renders text resources and describes binary ones', () => {
    const content = formatMcpToolResult(
      {
        content: [
          { type: 'resource', resource: { uri: 'file:///a', text: 'inline' } },
          { type: 'resource', resource: { uri: 'file:///b', blob: 'AAAA' } },
          { type: 'resource_link', uri: 'https://x', name: 'x', description: 'desc' },
        ],
      },
      1000,
    );
    expect(textOf({ content })).toBe(
      'inline\n[binary resource file:///b omitted]\n[resource link] https://x — desc',
    );
  });

  it('truncates oversized text with a note, within the cap', () => {
    const content = formatMcpToolResult(
      { content: [{ type: 'text', text: 'x'.repeat(500) }] },
      100,
    );
    const text = textOf({ content });
    expect(text.startsWith('x'.repeat(10))).toBe(true);
    expect(text).toContain('[truncated: result was 500 characters, limit is 100]');
    expect(text.length).toBeLessThanOrEqual(100);
  });

  it('keeps image omission notes within the cap', () => {
    const content = formatMcpToolResult(
      { content: [{ type: 'image', data: 'a'.repeat(100), mimeType: 'image/png' }] },
      10,
    );
    expect(content).toHaveLength(1);
    expect(textOf({ content }).length).toBeLessThanOrEqual(10);
  });

  it('returns only the notice when the cap is smaller than the notice', () => {
    const content = formatMcpToolResult({ content: [{ type: 'text', text: 'x'.repeat(50) }] }, 10);
    expect(textOf({ content })).toBe('\n\n[truncated: result was 50 characters, limit is 10]');
  });

  it('throws when the server flags the result as an error', () => {
    expect(() =>
      formatMcpToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }, 1000),
    ).toThrow('boom');
  });

  it('caps an oversized error result the same way as a successful one', () => {
    let message = '';
    try {
      formatMcpToolResult(
        { isError: true, content: [{ type: 'text', text: 'x'.repeat(5000) }] },
        10,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('[truncated: result was 5000 characters, limit is 10]');
    expect(message.length).toBeLessThan(200);
  });

  it('counts image bytes against the same budget and notes what it dropped', () => {
    const content = formatMcpToolResult(
      {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'a'.repeat(10), mimeType: 'image/png' },
          { type: 'image', data: 'b'.repeat(200), mimeType: 'image/png' },
        ],
      },
      60,
    );
    expect(content).toEqual([
      { type: 'text', text: 'hello\n[image omitted: 200 bytes]' },
      { type: 'image', data: 'a'.repeat(10), mimeType: 'image/png' },
    ]);
  });

  it('drops image blocks whose data or mimeType is not a string', () => {
    const content = formatMcpToolResult(
      {
        content: [
          { type: 'image', data: ['A'.repeat(1_000_000)], mimeType: 'image/png' },
          { type: 'image', data: {}, mimeType: 'image/png' },
          { type: 'image', data: 'AAAA', mimeType: 42 },
          { type: 'image', data: 'BBBB', mimeType: 'image/png' },
        ] as unknown as CallToolResult['content'],
      },
      200,
    );
    expect(content).toEqual([
      {
        type: 'text',
        text: '[invalid image content omitted]\n[invalid image content omitted]\n[invalid image content omitted]',
      },
      { type: 'image', data: 'BBBB', mimeType: 'image/png' },
    ]);
  });

  it('turns malformed blocks into short notes instead of throwing', () => {
    const huge = 'y'.repeat(1_000_000);
    const content = formatMcpToolResult(
      {
        content: [
          null,
          'z',
          { type: 'text', text: [huge] },
          { type: 'resource', resource: huge },
          { type: 'resource', resource: null },
          { type: 'resource_link', uri: 'https://x', description: {} },
        ] as unknown as CallToolResult['content'],
      },
      1000,
    );
    expect(textOf({ content })).toBe(
      [
        '[invalid content omitted]',
        '[invalid content omitted]',
        '[invalid text content omitted]',
        '[invalid resource content omitted]',
        '[invalid resource content omitted]',
        '[resource link] https://x',
      ].join('\n'),
    );
  });

  it('keeps the error message capped when an error result holds a malformed resource', () => {
    let message = '';
    try {
      formatMcpToolResult(
        {
          isError: true,
          content: [{ type: 'resource', resource: 'y'.repeat(1_000_000) }],
        } as unknown as CallToolResult,
        50,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('[invalid resource content omitted]');
  });

  it('counts the image mimeType against the budget', () => {
    const content = formatMcpToolResult(
      { content: [{ type: 'image', data: 'A', mimeType: 'x'.repeat(1_000_000) }] },
      100,
    );
    expect(content).toEqual([{ type: 'text', text: '[image omitted: 1 bytes]' }]);
  });

  it('keeps at most MAX_MCP_IMAGE_BLOCKS images however small they are', () => {
    const content = formatMcpToolResult(
      {
        content: Array.from({ length: MAX_MCP_IMAGE_BLOCKS + 2 }, () => ({
          type: 'image' as const,
          data: 'A',
          mimeType: 'image/png',
        })),
      },
      1000,
    );
    expect(content.filter((block) => block.type === 'image')).toHaveLength(MAX_MCP_IMAGE_BLOCKS);
    expect(content[0]).toEqual({
      type: 'text',
      text: '[image omitted: 1 bytes]\n[image omitted: 1 bytes]',
    });
  });
});

describe('inheritedMcpEnvironment', () => {
  it('keeps only the safe subset and skips exported shell functions', () => {
    expect(
      inheritedMcpEnvironment({
        PATH: '/usr/bin',
        HOME: '/home/ci',
        SHELL: '() { :; }',
        CODE_REVIEW_GITLAB_TOKEN: 'secret',
        ANTHROPIC_API_KEY: 'secret',
      }),
    ).toEqual(
      process.platform === 'win32' ? { PATH: '/usr/bin' } : { PATH: '/usr/bin', HOME: '/home/ci' },
    );
  });
});

describe('createMcpTransport', () => {
  it('builds a stdio transport that does not inherit the parent environment', () => {
    const transport = createMcpTransport(config('docs', { args: ['--x'], env: { A: '1' } }));
    expect(transport).toBeInstanceOf(StdioTransport);
    const { options } = transport as StdioTransport;
    expect(options.command).toBe('fake-server');
    expect(options.args).toEqual(['--x']);
    expect(options.inheritEnv).toBe(false);
    expect(options.env).toEqual({ ...inheritedMcpEnvironment(), A: '1' });
  });

  it('builds a streamable HTTP transport with the configured headers', () => {
    const transport = createMcpTransport(
      config('docs', {
        type: 'http',
        command: undefined,
        url: 'https://docs.test/mcp',
        headers: { Authorization: 'Bearer t' },
      }),
    );
    expect(transport).toBeInstanceOf(StreamableHttpTransport);
    const built = transport as StreamableHttpTransport;
    expect(built.url.href).toBe('https://docs.test/mcp');
    expect(built.options.headers).toEqual({ Authorization: 'Bearer t' });
    expect(built.options.openGetStream).toBe(false);
  });

  it('refuses a legacy SSE server with a hint to use streamable HTTP', () => {
    expect(() =>
      createMcpTransport(
        config('docs', { type: 'sse', command: undefined, url: 'https://docs.test/sse' }),
      ),
    ).toThrow("legacy SSE transport is not supported; use the server's streamable HTTP endpoint");
  });

  it('rejects a transport type the bridge cannot build', () => {
    expect(() =>
      createMcpTransport(config('bad', { type: 'ws' as unknown as McpServerConfig['type'] })),
    ).toThrow('Unsupported MCP transport');
  });
});

// ---------------------------------------------------------------------------
// connectMcpServers with an in-memory server
// ---------------------------------------------------------------------------

describe('connectMcpServers', () => {
  it('exposes only the read-only tool, mapped to mcp__<server>__<tool>', async () => {
    const fake = await startFakeServer();
    const logger = captureLogger();
    const conn = await connectMcpServers([config('tracker')], {
      logger,
      createTransport: () => fake.transport,
    });
    try {
      expect(conn.tools.map((t) => t.name)).toEqual(['mcp__tracker__get_issue']);
      expect(conn.tools[0]?.label).toBe('tracker: get_issue');
      expect(conn.tools[0]?.description).toBe('Read one issue.');
      expect(conn.tools[0]?.parameters).toMatchObject({
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      });
      expect(conn.servers).toEqual([
        {
          name: 'tracker',
          source: { kind: 'project', path: '.mcp.json' },
          status: 'connected',
          tools: ['get_issue'],
          calls: 0,
        },
      ]);
      expect(logger.lines.debug.join('\n')).toContain('dropped 2 tool(s)');
      expect(logger.lines.debug.join('\n')).toContain('search, delete_issue');
      expect(logger.lines.warn).toEqual([]);
    } finally {
      await conn.close();
    }
  });

  it('lists every page of a paginated tools/list', async () => {
    const fake = await startFakeServer(undefined, 1);
    const conn = await connectMcpServers([config('tracker')], {
      createTransport: () => fake.transport,
    });
    try {
      expect(fake.listRequests).toBe(TOOLS.length);
      expect(conn.tools.map((t) => t.name)).toEqual(['mcp__tracker__get_issue']);
    } finally {
      await conn.close();
    }
  });

  it('reports a legacy SSE server as unavailable with a hint', async () => {
    const logger = captureLogger();
    const conn = await connectMcpServers(
      [config('legacy', { type: 'sse', command: undefined, url: 'https://docs.test/sse' })],
      { logger },
    );
    try {
      expect(conn.servers[0]?.status).toBe('unavailable');
      expect(logger.lines.warn).toEqual([
        'MCP server "legacy" unavailable: legacy SSE transport is not supported; use the server\'s streamable HTTP endpoint',
      ]);
    } finally {
      await conn.close();
    }
  });

  it('execute calls the server and returns text content', async () => {
    const fake = await startFakeServer();
    const conn = await connectMcpServers([config('tracker')], {
      createTransport: () => fake.transport,
    });
    try {
      const tool = conn.tools[0]!;
      const result = await tool.execute('call-1', { id: '42' });
      expect(textOf(result)).toBe('get_issue:{"id":"42"}');
      expect(fake.calls).toEqual([{ name: 'get_issue', args: { id: '42' } }]);
      expect(conn.servers[0]?.calls).toBe(1);
    } finally {
      await conn.close();
    }
  });

  it('truncates oversized results', async () => {
    const fake = await startFakeServer(() => ({
      content: [{ type: 'text', text: 'y'.repeat(500) }],
    }));
    const conn = await connectMcpServers([config('tracker')], {
      createTransport: () => fake.transport,
      maxResultChars: 100,
    });
    try {
      const result = await conn.tools[0]!.execute('call-1', { id: '1' });
      const text = textOf(result);
      expect(text).toContain('[truncated: result was 500 characters, limit is 100]');
      expect(text.length).toBeLessThanOrEqual(100);
    } finally {
      await conn.close();
    }
  });

  it('throws when the server returns isError so the agent sees a failed call', async () => {
    const fake = await startFakeServer(() => ({
      isError: true,
      content: [{ type: 'text', text: 'not found' }],
    }));
    const conn = await connectMcpServers([config('tracker')], {
      createTransport: () => fake.transport,
    });
    try {
      await expect(conn.tools[0]!.execute('call-1', { id: '1' })).rejects.toThrow('not found');
    } finally {
      await conn.close();
    }
  });

  it('shares the call budget across tools and stops calling the server once exhausted', async () => {
    const fake = await startFakeServer();
    const conn = await connectMcpServers([config('tracker')], {
      createTransport: () => fake.transport,
      callBudget: 2,
    });
    try {
      const tool = conn.tools[0]!;
      await tool.execute('c1', { id: '1' });
      await tool.execute('c2', { id: '2' });
      const exhausted = await tool.execute('c3', { id: '3' });
      expect(textOf(exhausted)).toContain('MCP call budget exhausted (2 calls per review)');
      expect(fake.calls).toHaveLength(2);
      expect(conn.servers[0]?.calls).toBe(2);
    } finally {
      await conn.close();
    }
  });

  it('close() is idempotent', async () => {
    const fake = await startFakeServer();
    const conn = await connectMcpServers([config('tracker')], {
      createTransport: () => fake.transport,
    });
    await conn.close();
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it('reports a connect failure as unavailable without throwing', async () => {
    const logger = captureLogger();
    const conn = await connectMcpServers([config('broken')], {
      logger,
      createTransport: () => {
        throw new Error('dial https://user:secret@example.test failed');
      },
    });
    try {
      expect(conn.tools).toEqual([]);
      expect(conn.servers).toEqual([
        {
          name: 'broken',
          source: { kind: 'project', path: '.mcp.json' },
          status: 'unavailable',
          tools: [],
          calls: 0,
        },
      ]);
      expect(logger.lines.warn).toHaveLength(1);
      expect(logger.lines.warn[0]).toContain('MCP server "broken" unavailable');
      expect(logger.lines.warn[0]).not.toContain('secret');
    } finally {
      await conn.close();
    }
  });

  it('keeps healthy servers when another one fails', async () => {
    const fake = await startFakeServer();
    const conn = await connectMcpServers([config('broken'), config('tracker')], {
      createTransport: (cfg) => {
        if (cfg.name === 'broken') throw new Error('nope');
        return fake.transport;
      },
    });
    try {
      expect(conn.servers.map((s) => [s.name, s.status])).toEqual([
        ['broken', 'unavailable'],
        ['tracker', 'connected'],
      ]);
      expect(conn.tools.map((t) => t.name)).toEqual(['mcp__tracker__get_issue']);
    } finally {
      await conn.close();
    }
  });

  it('marks a stdio server whose command does not exist as unavailable', async () => {
    const logger = captureLogger();
    const conn = await connectMcpServers(
      [config('missing', { command: 'code-review-no-such-binary-xyz' })],
      { logger, timeoutMs: 5_000 },
    );
    try {
      expect(conn.servers[0]?.status).toBe('unavailable');
      expect(conn.tools).toEqual([]);
      expect(logger.lines.warn[0]).toContain('MCP server "missing" unavailable');
    } finally {
      await conn.close();
    }
  });

  it('uses the server timeout for calls', async () => {
    const fake = await startFakeServer(
      () =>
        new Promise<CallToolResult>((resolve) => {
          setTimeout(() => resolve({ content: [{ type: 'text', text: 'late' }] }), 200);
        }),
    );
    const conn = await connectMcpServers([config('slow', { timeoutMs: 20 })], {
      createTransport: () => fake.transport,
    });
    try {
      await expect(conn.tools[0]!.execute('c1', { id: '1' })).rejects.toThrow(/timed out/i);
    } finally {
      await conn.close();
    }
  });

  it('publishes mcp.connect, mcp.tools, and mcp.call diagnostics when runId is set', async () => {
    const fake = await startFakeServer();
    const events: Array<{ channel: string; ctx: McpDiagnosticContext }> = [];
    const record =
      (channel: string) =>
      (ctx: McpDiagnosticContext): void => {
        events.push({ channel, ctx });
      };
    const onConnect = record('connect');
    const onTools = record('tools');
    const onCall = record('call');
    mcpDiagnosticChannels.connect.asyncEnd.subscribe(onConnect);
    mcpDiagnosticChannels.tools.asyncEnd.subscribe(onTools);
    mcpDiagnosticChannels.call.asyncEnd.subscribe(onCall);

    const conn = await connectMcpServers([config('tracker')], {
      createTransport: () => fake.transport,
      runId: 'run-diag-1',
    });
    try {
      await conn.tools[0]!.execute('call-1', { id: '42' });
    } finally {
      mcpDiagnosticChannels.connect.asyncEnd.unsubscribe(onConnect);
      mcpDiagnosticChannels.tools.asyncEnd.unsubscribe(onTools);
      mcpDiagnosticChannels.call.asyncEnd.unsubscribe(onCall);
      await conn.close();
    }

    expect(events.map((e) => e.channel)).toEqual(['connect', 'tools', 'call']);
    for (const { ctx } of events) expect(ctx.runId).toBe('run-diag-1');
    expect(events[0]?.ctx).toMatchObject({ op: 'mcp.connect', server: 'tracker' });
    expect(events[1]?.ctx).toMatchObject({ op: 'mcp.tools', server: 'tracker', toolCount: 1 });
    const callCtx = events[2]?.ctx;
    expect(callCtx).toMatchObject({
      op: 'mcp.call',
      server: 'tracker',
      tool: 'get_issue',
      resultChars: 'get_issue:{"id":"42"}'.length,
    });
    // Arguments and results never reach the diagnostics payload (only their
    // char count does) — not even via Node's tracingChannel.tracePromise,
    // which otherwise assigns the traced function's return value as `.result`.
    expect(callCtx).not.toHaveProperty('args');
    expect((callCtx as { result?: unknown }).result).toBeUndefined();
    expect(JSON.stringify(callCtx)).not.toContain('get_issue:{');
  });

  it('publishes no diagnostics when runId is not set', async () => {
    const fake = await startFakeServer();
    const seen: McpDiagnosticContext[] = [];
    const onAsyncEnd = (ctx: McpDiagnosticContext) => seen.push(ctx);
    mcpDiagnosticChannels.call.asyncEnd.subscribe(onAsyncEnd);

    const conn = await connectMcpServers([config('tracker')], {
      createTransport: () => fake.transport,
    });
    try {
      await conn.tools[0]!.execute('call-1', { id: '42' });
    } finally {
      mcpDiagnosticChannels.call.asyncEnd.unsubscribe(onAsyncEnd);
      await conn.close();
    }

    expect(seen).toEqual([]);
  });

  it('uses the noop logger by default', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const conn = await connectMcpServers([config('broken')], {
      createTransport: () => {
        throw new Error('nope');
      },
    });
    await conn.close();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('drops a bridged tool whose name collides with an earlier server', async () => {
    // `jira.internal` and `jira_internal` both sanitise to `jira_internal`, so
    // their bridged tools would share one name and the later would shadow the
    // earlier in the agent's dispatch.
    const first = await startFakeServer();
    const second = await startFakeServer();
    const logger = captureLogger();
    const conn = await connectMcpServers([config('jira.internal'), config('jira_internal')], {
      logger,
      createTransport: (cfg) => (cfg.name === 'jira.internal' ? first.transport : second.transport),
    });
    try {
      expect(conn.tools.map((t) => t.name)).toEqual(['mcp__jira_internal__get_issue']);
      expect(conn.servers.map((s) => s.tools)).toEqual([['get_issue'], []]);
      expect(logger.lines.warn.join('\n')).toContain('collides');

      // The surviving tool is the first server's.
      await conn.tools[0]!.execute('call-1', { id: '42' });
      expect(first.calls).toHaveLength(1);
      expect(second.calls).toHaveLength(0);
    } finally {
      await conn.close();
    }
  });
});
