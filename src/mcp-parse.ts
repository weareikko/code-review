/**
 * Pure MCP server-definition parsing: `.mcp.json`-style document shapes,
 * `${VAR}` env expansion, and normalisation into `McpServerConfig`. Has no
 * dependency on the filesystem, git, or marketplaces, so both `mcp-config.ts`
 * (repo/file discovery) and `marketplaces.ts` (plugin sources) can depend on
 * it without forming a cycle between themselves.
 */

/**
 * Where an MCP server definition came from. Carried in enough detail to link
 * the server name in the summary footer back to its source (see the MCP
 * footer helper in `cli.ts`). `project.path` is the `.mcp.json` file relative to
 * the repository root, POSIX-separated, like `SkillOrigin.project`.
 */
export type McpServerSource =
  | { kind: 'project'; path: string }
  | {
      kind: 'marketplace';
      marketplace: string;
      plugin: string;
      url: string;
      ref: string;
      path: string;
    }
  | { kind: 'file'; path: string };

/** Transports we can connect to. `ws` is recognised in files but skipped. */
export type McpTransportType = 'stdio' | 'http' | 'sse';

/** A normalised, env-expanded MCP server definition ready to connect. */
export interface McpServerConfig {
  name: string;
  type: McpTransportType;
  /** stdio only. */
  command?: string;
  /** stdio only. */
  args: string[];
  /** stdio only — extra environment for the child process. */
  env: Record<string, string>;
  /** http / sse only. */
  url?: string;
  /** http / sse only. */
  headers: Record<string, string>;
  /** Per-call timeout; `undefined` means the bridge default. */
  timeoutMs?: number;
  source: McpServerSource;
}

/** Names disabled by a `.claude/settings.json` file. */
export interface McpDisableFilters {
  /** `disabledMcpjsonServers` — servers declared in repo `.mcp.json` files. */
  disabledMcpjsonServers: string[];
  /** `disabledMcpServers` — servers from any source (plugins included). */
  disabledMcpServers: string[];
}

/** Variables available to `${VAR}` expansion. Undefined values count as unset. */
export type McpEnvVars = Readonly<Record<string, string | undefined>>;

const KNOWN_TYPES = new Set(['stdio', 'http', 'sse', 'ws']);
// `${VAR}` or `${VAR:-default}`; the default may be empty.
const TEMPLATE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Upper bound on a server-declared `timeout`. A server definition governs its
 * own per-call timeout, but it must not be able to stall the review for hours:
 * connect and `tools/list` run before the agent loop, outside the review
 * timeout, so an unclamped value there is a one-line denial of service.
 */
export const MAX_MCP_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The subset of `env` an operator opted into exposing to `${VAR}` expansion.
 *
 * Server definitions can come from the repository under review or from a
 * marketplace plugin whose upstream ref moves, so expanding from the whole
 * process environment would let a definition read any secret the reviewer holds
 * (`CODE_REVIEW_GITLAB_TOKEN`, `ANTHROPIC_API_KEY`, …) and ship it out in argv,
 * a header, or a URL query string. Only names listed in `allowlist` are
 * readable; everything else expands as unset, which skips the server with a
 * warning that names the variable and never a value.
 */
export function pickMcpEnvVars(env: McpEnvVars, allowlist: readonly string[]): McpEnvVars {
  const picked: Record<string, string | undefined> = {};
  for (const name of allowlist) {
    if (env[name] !== undefined) picked[name] = env[name];
  }
  return picked;
}

/**
 * Expand `${VAR}` and `${VAR:-default}` references in `value`. Missing
 * variables (unset, with no default) are left untouched and reported by name in
 * `missing` so callers can skip the server without ever logging a value.
 *
 * `${VAR:-default}` follows POSIX: the default applies when `VAR` is unset *or*
 * empty. Bare `${VAR}` expands to an empty string when `VAR` is set but empty.
 */
export function expandMcpTemplate(
  value: string,
  vars: McpEnvVars,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const expanded = value.replace(TEMPLATE_PATTERN, (match, name: string, fallback?: string) => {
    const current = vars[name];
    if (fallback !== undefined) return current !== undefined && current !== '' ? current : fallback;
    if (current !== undefined) return current;
    if (!missing.includes(name)) missing.push(name);
    return match;
  });
  return { value: expanded, missing };
}

/**
 * Extract the server map from a parsed `.mcp.json`-style document. Two shapes
 * are accepted:
 *
 * - Claude Code project shape: `{ "mcpServers": { name: server } }`
 * - Plugin shape: `{ name: server }` (servers at the top level)
 *
 * The project shape is detected by a top-level `mcpServers` object. Returns
 * `null` when the document is not an object at all.
 */
export function extractMcpServerMap(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.mcpServers)) return raw.mcpServers;
  return raw;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/**
 * Drop headers whose value is empty or whitespace-only.
 *
 * A header value is routinely a `${VAR}` or `${VAR:-}` reference to a
 * credential that is simply absent — an optional API key, or a token only set
 * in CI. Sending `Authorization:` with no value is worse than not sending it:
 * some servers reject the malformed header outright where they would have
 * served the request anonymously. So an empty expansion means "no header",
 * not "empty header". `env` for stdio servers is deliberately left alone: an
 * empty environment variable is a meaningful, distinct value there.
 */
export function dropEmptyHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value.trim() !== ''));
}

/** Read the MCP disable lists from a parsed `.claude/settings.json` document. */
export function parseMcpDisableFilters(raw: unknown): McpDisableFilters {
  if (!isRecord(raw)) return { disabledMcpjsonServers: [], disabledMcpServers: [] };
  return {
    disabledMcpjsonServers: stringList(raw.disabledMcpjsonServers),
    disabledMcpServers: stringList(raw.disabledMcpServers),
  };
}

/** Options for `normalizeMcpServer` / `parseMcpServers`. */
export interface NormalizeMcpServerOptions {
  /**
   * Variables for `${VAR}` expansion. Defaults to none: the process
   * environment is never exposed implicitly — callers pass the operator's
   * allowlist (see `pickMcpEnvVars`).
   */
  vars?: McpEnvVars;
  /** Expanded from `${CLAUDE_PLUGIN_ROOT}` for marketplace plugins. */
  pluginRoot?: string;
  warn?: (msg: string) => void;
}

interface Expander {
  expand(value: string): string;
  missing: Set<string>;
}

function createExpander(vars: McpEnvVars): Expander {
  const missing = new Set<string>();
  return {
    missing,
    expand(value) {
      const result = expandMcpTemplate(value, vars);
      for (const name of result.missing) missing.add(name);
      return result.value;
    },
  };
}

function describeSource(source: McpServerSource): string {
  return source.kind === 'marketplace' ? `${source.marketplace}:${source.plugin}` : source.path;
}

/**
 * Normalise one raw server entry. Returns `null` (after warning) when the
 * server is unsupported or incomplete:
 *
 * - `type: ws`, or any `oauth` / `headersHelper` field — unsupported transports
 *   and auth flows
 * - no `command` for stdio, no `url` for http/sse, before or after expansion
 * - a `${VAR}` reference with no value and no default (the warning names the
 *   variable, never a value)
 *
 * `type` defaults to `stdio` when `command` is present and `http` when `url`
 * is present. A server-declared `timeout` is clamped to `MAX_MCP_TIMEOUT_MS`.
 */
export function normalizeMcpServer(
  name: string,
  raw: unknown,
  source: McpServerSource,
  options: NormalizeMcpServerOptions = {},
): McpServerConfig | null {
  const warn = options.warn ?? (() => {});
  const where = describeSource(source);
  if (!isRecord(raw)) {
    warn(`MCP server "${name}" in ${where} is not an object — skipped.`);
    return null;
  }
  if (raw.oauth !== undefined || raw.headersHelper !== undefined) {
    const field = raw.oauth !== undefined ? 'oauth' : 'headersHelper';
    warn(`MCP server "${name}" in ${where} uses "${field}", which is not supported — skipped.`);
    return null;
  }

  const hasCommand = typeof raw.command === 'string' && raw.command.length > 0;
  const hasUrl = typeof raw.url === 'string' && raw.url.length > 0;
  let type: string;
  if (typeof raw.type === 'string') {
    type = raw.type;
    if (!KNOWN_TYPES.has(type)) {
      warn(`MCP server "${name}" in ${where} has unknown type "${type}" — skipped.`);
      return null;
    }
  } else if (hasCommand) {
    type = 'stdio';
  } else if (hasUrl) {
    type = 'http';
  } else {
    warn(`MCP server "${name}" in ${where} has neither "command" nor "url" — skipped.`);
    return null;
  }
  if (type === 'ws') {
    warn(
      `MCP server "${name}" in ${where} uses the ws transport, which is not supported — skipped.`,
    );
    return null;
  }
  if (type === 'stdio' && !hasCommand) {
    warn(`MCP server "${name}" in ${where} is stdio but has no "command" — skipped.`);
    return null;
  }
  if (type !== 'stdio' && !hasUrl) {
    warn(`MCP server "${name}" in ${where} is ${type} but has no "url" — skipped.`);
    return null;
  }

  const vars: McpEnvVars = {
    ...options.vars,
    ...(options.pluginRoot === undefined ? {} : { CLAUDE_PLUGIN_ROOT: options.pluginRoot }),
  };
  const expander = createExpander(vars);
  const expandMap = (map: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, expander.expand(v)]));

  const config: McpServerConfig = {
    name,
    type: type as McpTransportType,
    args: [],
    env: {},
    headers: {},
    source,
  };
  if (type === 'stdio') {
    config.command = expander.expand(raw.command as string);
    config.args = stringList(raw.args).map((arg) => expander.expand(arg));
    config.env = expandMap(stringMap(raw.env));
  } else {
    config.url = expander.expand(raw.url as string);
    config.headers = dropEmptyHeaders(expandMap(stringMap(raw.headers)));
  }
  if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0) {
    config.timeoutMs = Math.min(raw.timeout, MAX_MCP_TIMEOUT_MS);
  }

  if (expander.missing.size > 0) {
    const names = [...expander.missing].map((v) => `\${${v}}`).join(', ');
    warn(
      `MCP server "${name}" in ${where} references unset environment variable(s) ${names} — skipped. Set them or add a default with \${VAR:-default}, and allow them with --mcp-env / CODE_REVIEW_MCP_ENV.`,
    );
    return null;
  }

  // Re-check the required field after expansion: `${CI_BIN:-}` outside CI is a
  // documented way to gate a server off, and it must skip cleanly here rather
  // than reach the transport as an empty command or URL.
  if (type === 'stdio' && !config.command) {
    warn(`MCP server "${name}" in ${where} expands to an empty "command" — skipped.`);
    return null;
  }
  if (type !== 'stdio' && !config.url) {
    warn(`MCP server "${name}" in ${where} expands to an empty "url" — skipped.`);
    return null;
  }
  return config;
}

/**
 * Parse a whole `.mcp.json`-style document (either shape) into normalised
 * server configs. Invalid entries are skipped with a warning.
 */
export function parseMcpServers(
  raw: unknown,
  source: McpServerSource,
  options: NormalizeMcpServerOptions = {},
): McpServerConfig[] {
  const map = extractMcpServerMap(raw);
  if (!map) {
    options.warn?.(`MCP config in ${describeSource(source)} is not a JSON object — skipped.`);
    return [];
  }
  const servers: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(map)) {
    const server = normalizeMcpServer(name, entry, source, options);
    if (server) servers.push(server);
  }
  return servers;
}

/** Drop servers named in either disable list. */
export function applyMcpDisableFilters(
  servers: readonly McpServerConfig[],
  filters: McpDisableFilters,
): McpServerConfig[] {
  const disabled = new Set([...filters.disabledMcpjsonServers, ...filters.disabledMcpServers]);
  return servers.filter((server) => !disabled.has(server.name));
}
