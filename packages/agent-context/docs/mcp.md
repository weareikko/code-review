# MCP configuration

← Back to the [README](../README.md)

This library resolves MCP server **definitions** (`McpServerConfig`). It does not connect to servers: each tool keeps its own client bridge.

## `resolveMcpServers(config, cwd, gitRoot, registry, options)`

Merges the sources in this order. A server declared by a later source replaces an earlier one with the same name.

1. **Repository `.mcp.json` files**, walked from `gitRoot` down to `cwd`, the closest file winning per name. Only when `config.mcpDiscovery` is `true`. `disabledMcpjsonServers` applies to these servers.
2. **Each spec of `config.mcp`**, in order: `file:<path>` loads a standalone document (a relative path resolves from `cwd`); `<marketplace>:<plugin>` loads every server of a plugin; `<marketplace>:<plugin>/<server>` loads one.
3. **Disable lists**, applied last over every source: `disabledMcpServers` from `.claude/settings.json` and `.claude/settings.local.json` (every level, both files, unioned), plus `config.disableMcp`.

A spec that fails to resolve is skipped with a warning (`Skipping MCP spec "<spec>": …`).

| Option      | Notes                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| `cacheDir`  | Required. The marketplace clone cache, usually `resolveSkillCacheDir(product)`.    |
| `vars`      | The variables `${VAR}` may read, usually `pickMcpEnvVars(process.env, allowlist)`. |
| `refresh`   | Clone the marketplaces again.                                                      |
| `envPrefix` | The tool's variable prefix, named in hints and warnings.                           |
| `warn`      | Receives the warnings.                                                             |

### Repository discovery is opt-in

`.mcp.json` is content of the repository the agent works on. In CI, the working tree is the branch of the merge request, so a server declared there runs a command or calls a URL that the author of the change chose. Turn discovery on only for repositories whose contributors you trust. Everywhere else, name the servers in `config.mcp`, which the operator controls.

## Document shapes

`parseMcpServers(raw, source, options)` accepts two shapes, detected by a top-level `mcpServers` object:

```json
{ "mcpServers": { "jira": { "command": "npx", "args": ["-y", "jira-mcp-server"] } } }
```

```json
{ "jira": { "command": "npx", "args": ["-y", "jira-mcp-server"] } }
```

| Field     | Notes                                                                             |
| --------- | --------------------------------------------------------------------------------- |
| `type`    | `stdio` or `http`. Defaults to `stdio` with `command`, `http` with `url`.         |
| `command` | stdio only.                                                                       |
| `args`    | stdio only.                                                                       |
| `env`     | stdio only. Extra environment for the child process.                              |
| `url`     | http only.                                                                        |
| `headers` | http only. A header whose value expands to blank is dropped (`dropEmptyHeaders`). |
| `timeout` | Per-call timeout in milliseconds, clamped to `MAX_MCP_TIMEOUT_MS` (120 s).        |

A server with `type: sse` or `ws`, an `oauth` or `headersHelper` field, no `command` / `url`, or an unknown `type` is skipped with a warning.

## `${VAR}` expansion

`${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env` values, `url` and `headers` values (`expandMcpTemplate`). The default applies when `VAR` is unset or empty, as in POSIX. `${CLAUDE_PLUGIN_ROOT}` expands to the plugin directory for marketplace servers.

Expansion reads **only** `vars`. Build it with `pickMcpEnvVars(process.env, allowlist)`: a server definition can come from the repository or from a marketplace whose ref moves, so it must not read the agent's own secrets. A reference to a variable that is not in `vars` and has no default skips the server; the warning names the variable, never a value.

## Disable lists

- `loadMcpDisableFilters(cwd, gitRoot, warn?)` reads `disabledMcpjsonServers` and `disabledMcpServers` from `.claude/settings.json` and `.claude/settings.local.json` in each directory from `gitRoot` to `cwd`.
- `parseMcpDisableFilters(raw)` reads them from one parsed document.
- `applyMcpDisableFilters(servers, filters)` drops the servers named in either list.

Enable keys are ignored: a tool never enables again a server that another configuration disabled.

## Marketplace plugins

`loadMarketplaceMcpServers(spec, registry, options)` reads two sources of a plugin: a `.mcp.json` next to the plugin, and the `mcpServers` field of its `.claude-plugin/plugin.json`. A name in both is taken from `plugin.json`.

## The read-only rule

`isReadOnlyMcpTool(tool)` is `true` only when `annotations.readOnlyHint === true` and `annotations.destructiveHint !== true`. An agent that reads attacker-controlled content (a merge request, an issue) must expose only these tools. A tool with no annotations counts as a write.
