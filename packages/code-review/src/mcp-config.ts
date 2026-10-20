import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { ConfigError } from './errors.js';
import type { Logger } from './logger.js';
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
import { toPosixPath } from './skills.js';

// Re-export the pure parsing layer so existing imports of `./mcp-config.js`
// (the bridge in `mcp.ts`, tests, …) keep working unchanged.
export {
  applyMcpDisableFilters,
  dropEmptyHeaders,
  expandMcpTemplate,
  extractMcpServerMap,
  MAX_MCP_TIMEOUT_MS,
  normalizeMcpServer,
  parseMcpDisableFilters,
  parseMcpServers,
  pickMcpEnvVars,
  type McpDisableFilters,
  type McpEnvVars,
  type McpServerConfig,
  type McpServerSource,
  type McpTransportType,
  type NormalizeMcpServerOptions,
} from './mcp-parse.js';

/** Directories from `gitRoot` down to `cwd`, inclusive, root first. */
function walkDirs(cwd: string, gitRoot: string): string[] {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.unshift(current);
    if (current === gitRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

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
}

/**
 * Collect the MCP disable lists declared in the repository: `.claude/settings.json`
 * and the gitignored project-local `.claude/settings.local.json` — where Claude
 * Code persists `disabledMcpjsonServers` when a developer declines a server —
 * in every directory from `gitRoot` down to `cwd`. Lists from every level and
 * both files are unioned. Enable keys are ignored: this tool never re-enables a
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
      for (const server of parseMcpServers(mcpFile.raw, source, { vars: options.vars, warn })) {
        found.set(server.name, server);
      }
    } else if (mcpFile.error === 'invalid') {
      warn?.(`${mcpPath} is not valid JSON — MCP servers from this file not loaded.`);
    }
  }

  return applyMcpDisableFilters([...found.values()], filters);
}

/** A parsed `--mcp` spec. Produced by `parseMcpSpec`. */
export type McpSpec =
  | { protocol: 'file'; path: string }
  | { protocol: 'marketplace'; marketplace: string; plugin: string; server: string };

/**
 * Parse a `--mcp` / `CODE_REVIEW_MCP` spec string, mirroring `parseSkillSpec`'s
 * conventions:
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
      throw new ConfigError(`Invalid --mcp spec: "${spec}"`, {
        hint: 'A file: spec needs a path, e.g. file:./mcp-extra.json.',
      });
    }
    return { protocol: 'file', path };
  }

  const colonIdx = spec.indexOf(':');
  if (colonIdx <= 0) {
    throw new ConfigError(`Invalid --mcp spec: "${spec}"`, {
      hint: 'Use file:<path>, <marketplace>:<plugin>, or <marketplace>:<plugin>/<server>.',
    });
  }
  const marketplace = spec.slice(0, colonIdx);
  const rest = spec.slice(colonIdx + 1);
  const slashIdx = rest.indexOf('/');
  const plugin = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const server = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
  if (!plugin || server.includes('/')) {
    throw new ConfigError(`Invalid --mcp spec: "${spec}"`, {
      hint: `Marketplace MCP servers use "<marketplace>:<plugin>" or "<marketplace>:<plugin>/<server>", e.g. "${marketplace || 'acme'}:dev/context7".`,
    });
  }
  return { protocol: 'marketplace', marketplace, plugin, server };
}

/** The slice of `Config` `resolveMcpServers` needs — kept structural to avoid importing `Config`. */
export interface McpServerSourcesConfig {
  /** Raw `--mcp` / `CODE_REVIEW_MCP` specs, in the order given. */
  mcp: string[];
  /** Server names to drop, applied last over every source. */
  disableMcp: string[];
  /** Whether to auto-discover `.mcp.json` files walked from `gitRoot` to `cwd`. Opt-in. */
  mcpDiscovery: boolean;
}

/** Load a `file:` MCP spec — a standalone `.mcp.json`-style document anywhere on disk. */
async function loadFileMcpServers(
  path: string,
  vars: McpEnvVars | undefined,
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
  return parseMcpServers(file.raw, source, { vars, warn });
}

/**
 * Resolve every MCP server for a review, merging sources in the approved order:
 *
 * 1. Repo auto-discovery (`.mcp.json` walked from `gitRoot` to `cwd`, closest
 *    wins, `disabledMcpjsonServers` applied) — only when `config.mcpDiscovery`
 *    is `true`, which is opt-in: `.mcp.json` is content of the repository under
 *    review, so a merge request could otherwise make the reviewer spawn a
 *    process of its choosing on the CI runner.
 * 2. Every `--mcp` / `CODE_REVIEW_MCP` spec, in the order given: a `file:` spec
 *    loads a standalone document, a `<marketplace>:<plugin>[/<server>]` spec
 *    loads from the registered marketplace. A later spec's server overrides an
 *    earlier one (from any source) of the same name.
 * 3. `disabledMcpServers` from `.claude/settings.json` (and `settings.local.json`)
 *    plus `config.disableMcp` (`--disable-mcp` / `CODE_REVIEW_DISABLE_MCP`),
 *    applied last over every source above — a name disabled there stays dropped
 *    even when a `--mcp` spec redeclares it.
 *
 * A spec that fails to resolve (bad file, unregistered marketplace, unknown
 * plugin/server) is skipped with a warning — one broken `--mcp` entry must not
 * abort the whole review.
 */
export async function resolveMcpServers(
  config: McpServerSourcesConfig,
  cwd: string,
  gitRoot: string,
  registry: MarketplaceRegistry,
  logger?: Logger,
  options: { vars?: McpEnvVars; refresh?: boolean } = {},
): Promise<McpServerConfig[]> {
  const warn = (msg: string): void => logger?.warn(msg);

  // Loaded even with discovery off: `disabledMcpServers` is not scoped to
  // project-declared servers, so it must reach `--mcp` sources too.
  const filters = await loadMcpDisableFilters(cwd, gitRoot, warn);

  const found = new Map<string, McpServerConfig>();
  if (config.mcpDiscovery) {
    for (const server of await loadAutoDiscoveredMcpServers(cwd, gitRoot, warn, {
      vars: options.vars,
      filters,
    })) {
      found.set(server.name, server);
    }
  }

  for (const raw of config.mcp) {
    try {
      const spec = parseMcpSpec(raw);
      const servers =
        spec.protocol === 'file'
          ? await loadFileMcpServers(spec.path, options.vars, warn)
          : await loadMarketplaceMcpServers(spec, registry, {
              vars: options.vars,
              refresh: options.refresh,
              warn,
            });
      for (const server of servers) found.set(server.name, server);
    } catch (error) {
      warn(`Skipping --mcp "${raw}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return applyMcpDisableFilters([...found.values()], {
    disabledMcpjsonServers: [],
    disabledMcpServers: [...filters.disabledMcpServers, ...config.disableMcp],
  });
}
