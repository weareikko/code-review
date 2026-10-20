import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { ConfigError } from './errors.js';
import { loadMarketplaceMcpServers, type MarketplaceRegistry } from './marketplaces.js';
import {
  applyMcpDisableFilters,
  parseMcpDisableFilters,
  parseMcpServers,
  type McpDisableFilters,
  type McpEnvVars,
  type McpServerConfig,
  type McpServerSource,
} from './mcp-parse.js';
import { toPosixPath, walkDirs } from './paths.js';

async function readJsonFile(
  path: string,
): Promise<{ raw: unknown } | { error: 'missing' | 'invalid' }> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return { error: 'missing' };
  }
  try {
    return { raw: JSON.parse(content) as unknown };
  } catch {
    return { error: 'invalid' };
  }
}

/** Options for `loadAutoDiscoveredMcpServers`. */
export interface LoadAutoDiscoveredMcpServersOptions {
  /** Variables for `${VAR}` expansion; defaults to none. */
  vars?: McpEnvVars;
  /** Disable lists to apply; loaded with `loadMcpDisableFilters` when omitted. */
  filters?: McpDisableFilters;
  /** The tool's environment variable prefix (`CODE_REVIEW_`), named in warnings. */
  envPrefix?: string;
}

/**
 * Collect the MCP disable lists declared in the repository: `.claude/settings.json`
 * and the gitignored project-local `.claude/settings.local.json` — where Claude
 * Code persists `disabledMcpjsonServers` when a developer declines a server —
 * in every directory from `gitRoot` down to `cwd`. Lists from every level and
 * both files are unioned. Enable keys are ignored: a tool never re-enables a
 * server another config disabled.
 */
export async function loadMcpDisableFilters(
  cwd: string,
  gitRoot: string,
  warn?: (msg: string) => void,
): Promise<McpDisableFilters> {
  const filters: McpDisableFilters = { disabledMcpjsonServers: [], disabledMcpServers: [] };
  for (const dir of walkDirs(cwd, gitRoot)) {
    for (const file of ['settings.json', 'settings.local.json']) {
      const settingsPath = join(dir, '.claude', file);
      const settingsFile = await readJsonFile(settingsPath);
      if ('raw' in settingsFile) {
        const parsed = parseMcpDisableFilters(settingsFile.raw);
        filters.disabledMcpjsonServers.push(...parsed.disabledMcpjsonServers);
        filters.disabledMcpServers.push(...parsed.disabledMcpServers);
      } else if (settingsFile.error === 'invalid') {
        warn?.(`${settingsPath} is not valid JSON — MCP disable lists from this file ignored.`);
      }
    }
  }
  return filters;
}

/**
 * Discover MCP servers declared in the repository, mirroring
 * `loadAutoDiscoveredSkills`: `.mcp.json` in every directory from `gitRoot` down
 * to `cwd`, the closest directory winning per server name.
 *
 * `disabledMcpjsonServers` is scoped to these project-declared servers and
 * applied here. `disabledMcpServers` is *not* scoped to them — it names a server
 * whatever its source — so `resolveMcpServers` applies it once at the end, over
 * marketplace and `file:` servers too.
 */
export async function loadAutoDiscoveredMcpServers(
  cwd: string,
  gitRoot: string,
  warn?: (msg: string) => void,
  options: LoadAutoDiscoveredMcpServersOptions = {},
): Promise<McpServerConfig[]> {
  const found = new Map<string, McpServerConfig>();
  const filters = options.filters ?? (await loadMcpDisableFilters(cwd, gitRoot, warn));

  for (const dir of walkDirs(cwd, gitRoot)) {
    const mcpPath = join(dir, '.mcp.json');
    const mcpFile = await readJsonFile(mcpPath);
    if ('raw' in mcpFile) {
      const source: McpServerSource = {
        kind: 'project',
        path: toPosixPath(relative(gitRoot, mcpPath)),
      };
      for (const server of parseMcpServers(mcpFile.raw, source, {
        vars: options.vars,
        envPrefix: options.envPrefix,
        warn,
      })) {
        found.set(server.name, server);
      }
    } else if (mcpFile.error === 'invalid') {
      warn?.(`${mcpPath} is not valid JSON — MCP servers from this file not loaded.`);
    }
  }

  return applyMcpDisableFilters([...found.values()], filters);
}

/** A parsed MCP spec. Produced by `parseMcpSpec`. */
export type McpSpec =
  | { protocol: 'file'; path: string }
  | { protocol: 'marketplace'; marketplace: string; plugin: string; server: string };

/**
 * Parse an MCP spec string (code-review's `--mcp` / `CODE_REVIEW_MCP`),
 * mirroring `parseSkillSpec`'s conventions:
 *
 * | Input                          | Result                                                          |
 * |---------------------------------|------------------------------------------------------------------|
 * | `file:./extra-servers.json`     | `{ protocol: 'file', path: './extra-servers.json' }`             |
 * | `acme:dev`                      | `{ protocol: 'marketplace', marketplace: 'acme', plugin: 'dev', server: '' }` |
 * | `acme:dev/context7`             | `{ protocol: 'marketplace', marketplace: 'acme', plugin: 'dev', server: 'context7' }` |
 *
 * An empty `server` means "every server the plugin exposes". Throws a
 * `ConfigError` with an actionable hint on any malformed input.
 */
export function parseMcpSpec(spec: string): McpSpec {
  if (spec.startsWith('file:')) {
    const path = spec.slice('file:'.length);
    if (!path) {
      throw new ConfigError(`Invalid MCP spec: "${spec}"`, {
        hint: 'A file: spec needs a path, e.g. file:./mcp-extra.json.',
      });
    }
    return { protocol: 'file', path };
  }

  const colonIdx = spec.indexOf(':');
  if (colonIdx <= 0) {
    throw new ConfigError(`Invalid MCP spec: "${spec}"`, {
      hint: 'Use file:<path>, <marketplace>:<plugin>, or <marketplace>:<plugin>/<server>.',
    });
  }
  const marketplace = spec.slice(0, colonIdx);
  const rest = spec.slice(colonIdx + 1);
  const slashIdx = rest.indexOf('/');
  const plugin = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const server = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
  if (!plugin || server.includes('/')) {
    throw new ConfigError(`Invalid MCP spec: "${spec}"`, {
      hint: `Marketplace MCP servers use "<marketplace>:<plugin>" or "<marketplace>:<plugin>/<server>", e.g. "${marketplace || 'acme'}:dev/context7".`,
    });
  }
  return { protocol: 'marketplace', marketplace, plugin, server };
}

/** The slice of a tool's configuration `resolveMcpServers` needs. */
export interface McpServerSourcesConfig {
  /** Raw MCP specs (`<prefix>MCP`), in the order given. */
  mcp: readonly string[];
  /** Server names to drop (`<prefix>DISABLE_MCP`), applied last over every source. */
  disableMcp: readonly string[];
  /** Whether to auto-discover `.mcp.json` files walked from `gitRoot` to `cwd`. Opt-in. */
  mcpDiscovery: boolean;
}

/** Load a `file:` MCP spec — a standalone `.mcp.json`-style document anywhere on disk. */
async function loadFileMcpServers(
  path: string,
  options: { vars?: McpEnvVars; envPrefix?: string },
  warn: (msg: string) => void,
): Promise<McpServerConfig[]> {
  const source: McpServerSource = { kind: 'file', path };
  const file = await readJsonFile(path);
  if ('error' in file) {
    warn(
      file.error === 'missing'
        ? `MCP file "${path}" does not exist — skipped.`
        : `MCP file "${path}" is not valid JSON — skipped.`,
    );
    return [];
  }
  return parseMcpServers(file.raw, source, {
    vars: options.vars,
    envPrefix: options.envPrefix,
    warn,
  });
}

/** Options for `resolveMcpServers`. */
export interface ResolveMcpServersOptions {
  /** The marketplace clone cache, usually `resolveSkillCacheDir(product)`. */
  cacheDir: string;
  /** Variables for `${VAR}` expansion, usually `pickMcpEnvVars(process.env, allowlist)`. */
  vars?: McpEnvVars;
  /** Re-clone marketplaces, bypassing the on-disk clone cache. */
  refresh?: boolean;
  /** The tool's environment variable prefix (`CODE_REVIEW_`), named in hints. */
  envPrefix?: string;
  warn?: (msg: string) => void;
}

/**
 * Resolve every MCP server for a run, merging sources in the approved order:
 *
 * 1. Repo auto-discovery (`.mcp.json` walked from `gitRoot` to `cwd`, closest
 *    wins, `disabledMcpjsonServers` applied) — only when `config.mcpDiscovery`
 *    is `true`, which is opt-in: `.mcp.json` is content of the repository the
 *    agent works on, so a merge request could otherwise make the agent spawn a
 *    process of its choosing on the runner.
 * 2. Every spec in `config.mcp`, in the order given: a `file:` spec loads a
 *    standalone document (a relative path resolves from `cwd`), a `<marketplace>:<plugin>[/<server>]` spec loads from
 *    the registered marketplace. A later spec's server overrides an earlier one
 *    (from any source) of the same name.
 * 3. `disabledMcpServers` from `.claude/settings.json` (and `settings.local.json`)
 *    plus `config.disableMcp`, applied last over every source above — a name
 *    disabled there stays dropped even when a spec redeclares it.
 *
 * A spec that fails to resolve (bad file, unregistered marketplace, unknown
 * plugin/server) is skipped with a warning — one broken entry must not abort
 * the whole run.
 */
export async function resolveMcpServers(
  config: McpServerSourcesConfig,
  cwd: string,
  gitRoot: string,
  registry: MarketplaceRegistry,
  options: ResolveMcpServersOptions,
): Promise<McpServerConfig[]> {
  const warn = (msg: string): void => options.warn?.(msg);

  // Loaded even with discovery off: `disabledMcpServers` is not scoped to
  // project-declared servers, so it must reach the spec sources too.
  const filters = await loadMcpDisableFilters(cwd, gitRoot, warn);

  const found = new Map<string, McpServerConfig>();
  if (config.mcpDiscovery) {
    for (const server of await loadAutoDiscoveredMcpServers(cwd, gitRoot, warn, {
      vars: options.vars,
      filters,
      envPrefix: options.envPrefix,
    })) {
      found.set(server.name, server);
    }
  }

  for (const raw of config.mcp) {
    try {
      const spec = parseMcpSpec(raw);
      const servers =
        spec.protocol === 'file'
          ? await loadFileMcpServers(resolve(cwd, spec.path), options, warn)
          : await loadMarketplaceMcpServers(spec, registry, {
              cacheDir: options.cacheDir,
              vars: options.vars,
              refresh: options.refresh,
              envPrefix: options.envPrefix,
              warn,
            });
      for (const server of servers) found.set(server.name, server);
    } catch (error) {
      warn(`Skipping MCP spec "${raw}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return applyMcpDisableFilters([...found.values()], {
    disabledMcpjsonServers: [],
    disabledMcpServers: [...filters.disabledMcpServers, ...config.disableMcp],
  });
}
