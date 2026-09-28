import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from './errors.js';
import { buildMarketplaceRegistry } from './marketplaces.js';
import {
  applyMcpDisableFilters,
  expandMcpTemplate,
  extractMcpServerMap,
  loadAutoDiscoveredMcpServers,
  normalizeMcpServer,
  parseMcpDisableFilters,
  parseMcpServers,
  parseMcpSpec,
  resolveMcpServers,
  type McpServerSource,
} from './mcp-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _tmpSeq = 0;
async function makeTmp(): Promise<string> {
  const dir = join(tmpdir(), `mcp-config-test-${process.pid}-${++_tmpSeq}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

const source: McpServerSource = { kind: 'project', path: '.mcp.json' };
const vars = { HOME: '/home/me', TOKEN: 'secret-value' };

// ---------------------------------------------------------------------------
// expandMcpTemplate
// ---------------------------------------------------------------------------

describe('expandMcpTemplate', () => {
  it('expands ${VAR} from the provided vars', () => {
    expect(expandMcpTemplate('${HOME}/bin', vars)).toEqual({ value: '/home/me/bin', missing: [] });
  });

  it('uses the default when the var is unset', () => {
    expect(expandMcpTemplate('${PORT:-8080}', vars)).toEqual({ value: '8080', missing: [] });
  });

  it('prefers the var over the default when set', () => {
    expect(expandMcpTemplate('${HOME:-/nope}', vars).value).toBe('/home/me');
  });

  it('accepts an empty default', () => {
    expect(expandMcpTemplate('a${NOPE:-}b', vars)).toEqual({ value: 'ab', missing: [] });
  });

  it('reports missing vars by name and leaves the reference untouched', () => {
    expect(expandMcpTemplate('${A}-${B}-${A}', vars)).toEqual({
      value: '${A}-${B}-${A}',
      missing: ['A', 'B'],
    });
  });

  it('treats an undefined value as unset', () => {
    expect(expandMcpTemplate('${X:-d}', { X: undefined })).toEqual({ value: 'd', missing: [] });
  });
});

// ---------------------------------------------------------------------------
// extractMcpServerMap
// ---------------------------------------------------------------------------

describe('extractMcpServerMap', () => {
  it('reads the Claude Code project shape', () => {
    expect(extractMcpServerMap({ mcpServers: { a: { command: 'x' } } })).toEqual({
      a: { command: 'x' },
    });
  });

  it('reads the plugin shape (servers at top level)', () => {
    expect(extractMcpServerMap({ a: { command: 'x' } })).toEqual({ a: { command: 'x' } });
  });

  it('returns null for non-objects', () => {
    expect(extractMcpServerMap(null)).toBeNull();
    expect(extractMcpServerMap([])).toBeNull();
    expect(extractMcpServerMap('x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeMcpServer
// ---------------------------------------------------------------------------

describe('normalizeMcpServer', () => {
  it('infers stdio when command is present', () => {
    const server = normalizeMcpServer(
      'fs',
      { command: 'npx', args: ['-y', 'server'], env: { A: '1' }, timeout: 5000 },
      source,
      { vars },
    );
    expect(server).toEqual({
      name: 'fs',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { A: '1' },
      headers: {},
      timeoutMs: 5000,
      source,
    });
  });

  it('infers http when url is present', () => {
    const server = normalizeMcpServer(
      'docs',
      { url: 'https://example.test/mcp', headers: { 'X-A': 'b' } },
      source,
      { vars },
    );
    expect(server).toMatchObject({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { 'X-A': 'b' },
      args: [],
      env: {},
    });
    expect(server?.timeoutMs).toBeUndefined();
  });

  it('honours an explicit sse type', () => {
    const server = normalizeMcpServer('s', { type: 'sse', url: 'https://x.test/sse' }, source, {
      vars,
    });
    expect(server?.type).toBe('sse');
  });

  it('expands ${VAR} in command, args, env, url and headers', () => {
    const stdio = normalizeMcpServer(
      'a',
      { command: '${HOME}/bin/x', args: ['--t=${TOKEN}'], env: { H: '${HOME}' } },
      source,
      { vars },
    );
    expect(stdio).toMatchObject({
      command: '/home/me/bin/x',
      args: ['--t=secret-value'],
      env: { H: '/home/me' },
    });
    const http = normalizeMcpServer(
      'b',
      { url: 'https://x.test/${HOME}', headers: { Authorization: 'Bearer ${TOKEN}' } },
      source,
      { vars },
    );
    expect(http).toMatchObject({
      url: 'https://x.test//home/me',
      headers: { Authorization: 'Bearer secret-value' },
    });
  });

  it('expands ${CLAUDE_PLUGIN_ROOT} from pluginRoot', () => {
    const server = normalizeMcpServer(
      'p',
      { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] },
      {
        kind: 'marketplace',
        marketplace: 'acme',
        plugin: 'dev',
        url: 'https://host/acme.git',
        ref: '',
        path: 'plugins/dev',
      },
      { vars, pluginRoot: '/cache/acme/plugins/dev' },
    );
    expect(server?.args).toEqual(['/cache/acme/plugins/dev/server.js']);
  });

  it('applies ${VAR:-default} when the var is unset', () => {
    const server = normalizeMcpServer('d', { url: '${MCP_URL:-https://d.test/mcp}' }, source, {
      vars,
    });
    expect(server?.url).toBe('https://d.test/mcp');
  });

  it('skips a server referencing an unset var and names the var, never a value', () => {
    const warn = vi.fn();
    const server = normalizeMcpServer(
      'x',
      { command: 'x', env: { A: '${MISSING_ONE}', B: '${TOKEN}' } },
      source,
      { vars, warn },
    );
    expect(server).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('"x"');
    expect(message).toContain('${MISSING_ONE}');
    expect(message).not.toContain('secret-value');
  });

  it.each([
    ['ws', { type: 'ws', url: 'wss://x.test' }, 'ws transport'],
    ['oauth', { url: 'https://x.test', oauth: {} }, '"oauth"'],
    ['headersHelper', { url: 'https://x.test', headersHelper: 'cmd' }, '"headersHelper"'],
    ['unknown type', { type: 'grpc', url: 'https://x.test' }, 'unknown type "grpc"'],
    ['no command or url', { args: [] }, 'neither "command" nor "url"'],
    ['stdio without command', { type: 'stdio', url: 'https://x.test' }, 'no "command"'],
    ['http without url', { type: 'http', command: 'x' }, 'no "url"'],
    ['not an object', 'nope', 'not an object'],
  ])('skips %s with a warning', (_label, raw, fragment) => {
    const warn = vi.fn();
    expect(normalizeMcpServer('srv', raw, source, { vars, warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(fragment);
  });

  it('ignores non-positive or non-numeric timeouts', () => {
    expect(
      normalizeMcpServer('t', { command: 'x', timeout: '5' }, source, { vars })?.timeoutMs,
    ).toBeUndefined();
    expect(
      normalizeMcpServer('t', { command: 'x', timeout: 0 }, source, { vars })?.timeoutMs,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseMcpServers / filters
// ---------------------------------------------------------------------------

describe('parseMcpServers', () => {
  it('parses both shapes and skips invalid entries', () => {
    const warn = vi.fn();
    const project = parseMcpServers(
      { mcpServers: { a: { command: 'a' }, bad: { type: 'ws', url: 'wss://x' } } },
      source,
      { vars, warn },
    );
    expect(project.map((s) => s.name)).toEqual(['a']);
    const plugin = parseMcpServers({ b: { url: 'https://b.test' } }, source, { vars, warn });
    expect(plugin.map((s) => s.name)).toEqual(['b']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns and returns nothing for a non-object document', () => {
    const warn = vi.fn();
    expect(parseMcpServers([], source, { vars, warn })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('parseMcpDisableFilters', () => {
  it('reads both disable lists and ignores enable lists and junk', () => {
    expect(
      parseMcpDisableFilters({
        disabledMcpjsonServers: ['a', 1],
        disabledMcpServers: ['b'],
        enabledMcpjsonServers: ['c'],
      }),
    ).toEqual({ disabledMcpjsonServers: ['a'], disabledMcpServers: ['b'] });
    expect(parseMcpDisableFilters(null)).toEqual({
      disabledMcpjsonServers: [],
      disabledMcpServers: [],
    });
  });
});

describe('applyMcpDisableFilters', () => {
  it('drops servers named in either list', () => {
    const servers = ['a', 'b', 'c'].map((name) =>
      normalizeMcpServer(name, { command: name }, source, { vars }),
    );
    const kept = applyMcpDisableFilters(
      servers.filter((s) => s !== null),
      { disabledMcpjsonServers: ['a'], disabledMcpServers: ['c'] },
    );
    expect(kept.map((s) => s.name)).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// loadAutoDiscoveredMcpServers
// ---------------------------------------------------------------------------

describe('loadAutoDiscoveredMcpServers', () => {
  it('returns an empty list when nothing is declared', async () => {
    const root = await makeTmp();
    expect(await loadAutoDiscoveredMcpServers(root, root, undefined, { vars })).toEqual([]);
  });

  it('loads servers from the root .mcp.json with a project source path', async () => {
    const root = await makeTmp();
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: { docs: { url: 'https://docs.test/mcp' } },
    });
    const servers = await loadAutoDiscoveredMcpServers(root, root, undefined, { vars });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'docs',
      type: 'http',
      source: { kind: 'project', path: '.mcp.json' },
    });
  });

  it('lets the closest .mcp.json win per server name', async () => {
    const root = await makeTmp();
    const cwd = join(root, 'apps', 'web');
    await mkdir(cwd, { recursive: true });
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: { shared: { command: 'root-cmd' }, only_root: { command: 'r' } },
    });
    await writeJson(join(cwd, '.mcp.json'), {
      mcpServers: { shared: { command: 'web-cmd' }, only_web: { command: 'w' } },
    });
    const servers = await loadAutoDiscoveredMcpServers(cwd, root, undefined, { vars });
    const byName = new Map(servers.map((s) => [s.name, s]));
    expect([...byName.keys()].toSorted()).toEqual(['only_root', 'only_web', 'shared']);
    expect(byName.get('shared')).toMatchObject({
      command: 'web-cmd',
      source: { kind: 'project', path: 'apps/web/.mcp.json' },
    });
    expect(byName.get('only_root')?.source).toEqual({ kind: 'project', path: '.mcp.json' });
  });

  it('applies disable lists from .claude/settings.json at every level', async () => {
    const root = await makeTmp();
    const cwd = join(root, 'pkg');
    await mkdir(cwd, { recursive: true });
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' } },
    });
    await writeJson(join(root, '.claude', 'settings.json'), {
      disabledMcpjsonServers: ['a'],
      enabledMcpjsonServers: ['b'],
    });
    await writeJson(join(cwd, '.claude', 'settings.json'), { disabledMcpServers: ['c'] });
    const servers = await loadAutoDiscoveredMcpServers(cwd, root, undefined, { vars });
    expect(servers.map((s) => s.name)).toEqual(['b']);
  });

  it('skips servers with unset vars and warns, keeping the rest', async () => {
    const root = await makeTmp();
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: {
        needs_token: { url: 'https://x.test', headers: { Authorization: '${UNSET_TOKEN}' } },
        fine: { url: '${UNSET_URL:-https://fine.test}' },
      },
    });
    const warn = vi.fn();
    const servers = await loadAutoDiscoveredMcpServers(root, root, warn, { vars });
    expect(servers.map((s) => s.name)).toEqual(['fine']);
    expect(servers[0]?.url).toBe('https://fine.test');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('${UNSET_TOKEN}');
  });

  it('warns on invalid JSON and continues', async () => {
    const root = await makeTmp();
    await writeFile(join(root, '.mcp.json'), '{ not json', 'utf8');
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'settings.json'), '{{', 'utf8');
    const warn = vi.fn();
    expect(await loadAutoDiscoveredMcpServers(root, root, warn, { vars })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('.mcp.json');
    expect(warn.mock.calls[1][0]).toContain('settings.json');
  });

  it('defaults to process.env for expansion', async () => {
    const root = await makeTmp();
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: { p: { command: '${MCP_TEST_CMD}' } },
    });
    vi.stubEnv('MCP_TEST_CMD', 'from-env');
    try {
      const servers = await loadAutoDiscoveredMcpServers(root, root);
      expect(servers[0]?.command).toBe('from-env');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// parseMcpSpec
// ---------------------------------------------------------------------------

describe('parseMcpSpec', () => {
  it('parses a file: spec', () => {
    expect(parseMcpSpec('file:./extra.json')).toEqual({ protocol: 'file', path: './extra.json' });
  });

  it('parses <marketplace>:<plugin>, with an empty server meaning "every server"', () => {
    expect(parseMcpSpec('acme:dev')).toEqual({
      protocol: 'marketplace',
      marketplace: 'acme',
      plugin: 'dev',
      server: '',
    });
  });

  it('parses <marketplace>:<plugin>/<server>', () => {
    expect(parseMcpSpec('acme:dev/context7')).toEqual({
      protocol: 'marketplace',
      marketplace: 'acme',
      plugin: 'dev',
      server: 'context7',
    });
  });

  it('throws on a file: spec with no path', () => {
    expect(() => parseMcpSpec('file:')).toThrow(ConfigError);
  });

  it('throws on a spec with no ":"', () => {
    expect(() => parseMcpSpec('acme')).toThrow(ConfigError);
  });

  it('throws on a server segment with an extra "/"', () => {
    expect(() => parseMcpSpec('acme:dev/context7/extra')).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// resolveMcpServers
// ---------------------------------------------------------------------------

describe('resolveMcpServers', () => {
  const emptyRegistry = buildMarketplaceRegistry([]);

  it('auto-discovers repo servers when mcpDiscovery is true (the default)', async () => {
    const root = await makeTmp();
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: { docs: { url: 'https://docs.test/mcp' } },
    });
    const servers = await resolveMcpServers(
      { mcp: [], disableMcp: [], mcpDiscovery: true },
      root,
      root,
      emptyRegistry,
      undefined,
      { vars },
    );
    expect(servers.map((s) => s.name)).toEqual(['docs']);
  });

  it('skips repo auto-discovery when mcpDiscovery is false', async () => {
    const root = await makeTmp();
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: { docs: { url: 'https://docs.test/mcp' } },
    });
    const servers = await resolveMcpServers(
      { mcp: [], disableMcp: [], mcpDiscovery: false },
      root,
      root,
      emptyRegistry,
      undefined,
      { vars },
    );
    expect(servers).toEqual([]);
  });

  it('merges a file: --mcp spec with repo auto-discovery, a later spec winning by name', async () => {
    const root = await makeTmp();
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: { shared: { command: 'repo-cmd' }, repo_only: { command: 'r' } },
    });
    const extra = join(root, 'extra.json');
    await writeJson(extra, { shared: { command: 'file-cmd' }, file_only: { command: 'f' } });

    const servers = await resolveMcpServers(
      { mcp: [`file:${extra}`], disableMcp: [], mcpDiscovery: true },
      root,
      root,
      emptyRegistry,
      undefined,
      { vars },
    );
    const byName = new Map(servers.map((s) => [s.name, s]));
    expect([...byName.keys()].toSorted()).toEqual(['file_only', 'repo_only', 'shared']);
    expect(byName.get('shared')?.command).toBe('file-cmd');
  });

  it('applies disableMcp last, over every source', async () => {
    const root = await makeTmp();
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: { a: { command: 'a' }, b: { command: 'b' } },
    });
    const servers = await resolveMcpServers(
      { mcp: [], disableMcp: ['a'], mcpDiscovery: true },
      root,
      root,
      emptyRegistry,
      undefined,
      { vars },
    );
    expect(servers.map((s) => s.name)).toEqual(['b']);
  });

  it('warns and skips a --mcp spec that fails to parse, keeping the rest', async () => {
    const root = await makeTmp();
    const warn = vi.fn();
    const extra = join(root, 'extra.json');
    await writeJson(extra, { ok: { command: 'x' } });
    const servers = await resolveMcpServers(
      { mcp: ['not-a-valid-spec', `file:${extra}`], disableMcp: [], mcpDiscovery: false },
      root,
      root,
      emptyRegistry,
      { warn, debug: () => {}, info: () => {}, error: () => {} },
      { vars },
    );
    expect(servers.map((s) => s.name)).toEqual(['ok']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-a-valid-spec'));
  });

  it('warns and skips a file: spec whose file does not exist', async () => {
    const root = await makeTmp();
    const warn = vi.fn();
    const servers = await resolveMcpServers(
      { mcp: [`file:${join(root, 'missing.json')}`], disableMcp: [], mcpDiscovery: false },
      root,
      root,
      emptyRegistry,
      { warn, debug: () => {}, info: () => {}, error: () => {} },
      { vars },
    );
    expect(servers).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not exist'));
  });

  it('warns and skips a marketplace --mcp spec for an unregistered marketplace', async () => {
    const warn = vi.fn();
    const root = await makeTmp();
    const servers = await resolveMcpServers(
      { mcp: ['acme:dev/context7'], disableMcp: [], mcpDiscovery: false },
      root,
      root,
      emptyRegistry,
      { warn, debug: () => {}, info: () => {}, error: () => {} },
      { vars },
    );
    expect(servers).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('acme:dev/context7'));
  });
});
