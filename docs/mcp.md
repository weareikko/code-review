# MCP servers

← Back to the [README](../README.md)

The reviewer can connect to [Model Context Protocol](https://modelcontextprotocol.io) servers and call their **read-only** tools while it reviews — resolving an issue reference, a ticket key, or a doc link before it forms an opinion on the code. This is separate from [skills](./skills.md): a skill is instructions, an MCP server is live tool access.

## Sources

MCP servers are loaded from four sources, in this order. A server name declared by a later source overrides an earlier one of the same name.

1. **Repo `.mcp.json` files** — walked from the git root down to `cwd`, the same walk [project skill auto-discovery](./skills.md#project-skills-auto-discovery) uses. The closest file wins per server name.
2. **Repo `.claude/settings.json`** at the same levels — `disabledMcpjsonServers` and `disabledMcpServers` from every level are unioned and applied last, after every other source. Enable keys are ignored; this tool never re-enables a server another config disabled.
3. **Marketplace plugins**, via `--mcp <marketplace>:<plugin>` (every server the plugin exposes) or `--mcp <marketplace>:<plugin>/<server>` (one server), reusing the [marketplace](./skills.md#marketplaces) clone cache and registry — declare the marketplace first with `--marketplace` / `CODE_REVIEW_MARKETPLACES`.
4. **An explicit file**, via `--mcp file:<path>`.

Disable repo auto-discovery entirely with `--no-mcp-discovery` / `CODE_REVIEW_MCP_DISCOVERY=false` — useful when every server should come from `--mcp` instead.

## `.mcp.json` shapes

Two document shapes are accepted, detected by the presence of a top-level `mcpServers` object:

```json
// Claude Code project shape
{
  "mcpServers": {
    "jira": { "command": "npx", "args": ["-y", "jira-mcp-server"] }
  }
}
```

```json
// Plugin shape — servers at the top level
{
  "jira": { "command": "npx", "args": ["-y", "jira-mcp-server"] }
}
```

### Server fields

| Field     | Notes                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `type`    | `stdio`, `http`, or `sse`. Defaults to `stdio` when `command` is present, `http` when `url` is present. |
| `command` | stdio only. The executable to spawn.                                                                    |
| `args`    | stdio only. Arguments passed to `command`.                                                              |
| `env`     | stdio only. Extra environment variables for the child process.                                          |
| `url`     | http / sse only. The server endpoint.                                                                   |
| `headers` | http / sse only. Request headers (e.g. an auth token).                                                  |
| `timeout` | Per-call timeout in milliseconds. Falls back to the bridge default (30s) when unset.                    |

A server declared with `type: ws`, or with an `oauth` or `headersHelper` field, is skipped with a warning — those transports and auth flows aren't supported.

## Env expansion

`${VAR}` and `${VAR:-default}` are expanded from `process.env` in `command`, `args`, `env` values, `url`, and `headers` values. `${CLAUDE_PLUGIN_ROOT}` additionally expands to the plugin's own directory for marketplace-sourced servers, the same as it does for skills.

A reference to an unset variable with no default skips that server, and the warning names the variable only — never a value — so a token never reaches the logs:

```
MCP server "jira" in .mcp.json references unset environment variable(s) ${JIRA_TOKEN} — skipped. Set them or add a default with ${VAR:-default}.
```

This is how CI authentication is threaded through: keep the token out of `.mcp.json` and set it as a CI/CD variable instead —

```json
{
  "jira": {
    "command": "npx",
    "args": ["-y", "jira-mcp-server"],
    "env": { "JIRA_TOKEN": "${JIRA_TOKEN}" }
  }
}
```

```yml
variables:
  JIRA_TOKEN: $JIRA_TOKEN # masked CI/CD variable
```

## The read-only gate

The reviewer processes attacker-controlled MR content — a malicious diff or description could try to steer it into calling a destructive tool. So only tools that declare themselves safe are exposed: `annotations.readOnlyHint === true` and `annotations.destructiveHint !== true`. Everything else — write, delete, or unannotated tools — is dropped before the agent ever sees it, and dropped tools are logged once per server at debug level. A server exposing zero read-only tools still counts as connected; it simply contributes nothing to the tool list.

## CLI flags and environment variables

| Flag                   | Environment variable              | Notes                                                                                                        |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--mcp <spec>`         | `CODE_REVIEW_MCP`                 | Repeatable / comma-separated. `file:<path>`, `<marketplace>:<plugin>`, or `<marketplace>:<plugin>/<server>`. |
| `--disable-mcp <name>` | `CODE_REVIEW_DISABLE_MCP`         | Repeatable / comma-separated. Server names to drop, applied last over every source.                          |
| `--no-mcp-discovery`   | `CODE_REVIEW_MCP_DISCOVERY=false` | Turns off repo `.mcp.json` / `.claude/settings.json` auto-discovery.                                         |

A spec that fails to resolve — a missing file, an unregistered marketplace, an unknown plugin or server — is skipped with a warning; one bad `--mcp` entry never aborts the review.

## Marketplace plugins

A marketplace plugin can ship MCP servers the same way it ships skills: a `.mcp.json` colocated with the plugin, the `mcpServers` field of its `.claude-plugin/plugin.json`, or both (a name in both is taken from `plugin.json`). See [Skills → Marketplaces](./skills.md#marketplaces) for declaring `--marketplace` / `CODE_REVIEW_MARKETPLACES`.

For example, given a marketplace registered as `ikko`, a plugin's `dev/.mcp.json` in the plugin shape:

```json
{
  "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
}
```

is loaded with:

```bash
code-review --marketplace 'ikko=git+ssh://git@gitlab.studiometa.dev/ikko/ikko-tools.git#main' --mcp ikko:dev
# or a single server from the same plugin:
code-review --marketplace 'ikko=git+ssh://git@gitlab.studiometa.dev/ikko/ikko-tools.git#main' --mcp ikko:dev/context7
```

## Prompt context

Connected servers and their exposed tools are listed in one `<external-context>` block in the reviewer's prompt. The agent is told to resolve issue references, ticket keys, and doc links found in the MR intent or commits _before_ reviewing — but external context stays secondary to code defects; it never outranks a finding grounded in the diff itself. No block is added when no server connected, so a review with no MCP config is unchanged.

## Summary footer

When at least one server was configured, the summary note carries an `MCP:` line next to the `Skills:` line, listing only exposed read-only tools:

```md
MCP: [jira](https://gitlab.example.com/team/app/-/blob/a1b2c3d/.mcp.json) (get_issue, search_issues), docs (unavailable)
```

A server name links to its source when reachable: a repo `.mcp.json` links to that file's blob at the reviewed commit (CI project coordinates required); a marketplace plugin links to the plugin's directory in the marketplace repository. A `file:` source, or a repo server on a run without CI project coordinates, stays an unlinked name — same rule as the [skills footer](./skills.md#skills-footer).

## Limits and budget

| Limit                  | Default       | Notes                                                                                                                                                                                        |
| ---------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-call timeout       | 30s           | Overridable per server with `timeout` in `.mcp.json`; also used for connect and `tools/list`.                                                                                                |
| Result size cap        | 200,000 chars | A longer result is truncated with a trailing note stating the original length.                                                                                                               |
| Call budget per review | 40 calls      | Shared across every MCP tool and every server. Once exhausted, a call returns a text telling the agent the budget is gone instead of erroring — the review continues on what it already has. |

## Diagnostics and OpenTelemetry

Connect, list-tools, and call-tool operations are traced on `diagnostics_channel` and, with `CODE_REVIEW_OTEL=1`, rendered as span events and a per-server call-count attribute. See [Observability](./observability.md) for the channel names, payload shapes, and OTel attribute names.

## Troubleshooting

- **A server never appears in the footer.** It failed to resolve before connecting — check the CLI warning: a malformed `--mcp` spec, an unregistered marketplace, or invalid JSON in `.mcp.json` all warn and skip rather than fail the review.
- **A server shows `(unavailable)`.** It resolved but the connection failed (bad command, unreachable URL, timeout) — check the warning logged at connect time; the review continues without it.
- **A tool the server offers is missing from the footer.** It either lacks `readOnlyHint: true`, or sets `destructiveHint: true` — the gate drops it on purpose. Check the server's tool annotations; this tool cannot expose it without them.
- **`${VAR}` shows up literally in a command or URL.** The variable is unset and has no `:-default` — the server was skipped; the warning names the missing variable.
- **A CI-only server should not run locally.** Gate it in `.mcp.json` with a `${VAR:-}` default that resolves to nothing outside CI, or use `--disable-mcp <name>` / `CODE_REVIEW_DISABLE_MCP` locally.
