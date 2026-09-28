# MCP servers

← Back to the [README](../README.md)

The reviewer can connect to [Model Context Protocol](https://modelcontextprotocol.io) servers and call their **read-only** tools while it reviews — resolving an issue reference or a ticket key before it forms an opinion on the code. This is separate from [skills](./skills.md): a skill is instructions, an MCP server is live tool access.

## Sources

MCP servers are loaded from four sources, in this order. A server name declared by a later source overrides an earlier one of the same name.

1. **Marketplace plugins**, via `--mcp <marketplace>:<plugin>` (every server the plugin exposes) or `--mcp <marketplace>:<plugin>/<server>` (one server), reusing the [marketplace](./skills.md#marketplaces) clone cache and registry — declare the marketplace first with `--marketplace` / `CODE_REVIEW_MARKETPLACES`.
2. **An explicit file**, via `--mcp file:<path>`.
3. **Repo `.mcp.json` files** — walked from the git root down to `cwd`, the same walk [project skill auto-discovery](./skills.md#project-skills-auto-discovery) uses, the closest file winning per server name. **Off by default**; see [Repo auto-discovery is opt-in](#repo-auto-discovery-is-opt-in).
4. **Repo `.claude/settings.json` and `.claude/settings.local.json`** at the same levels — `disabledMcpjsonServers` and `disabledMcpServers` from every level and both files are unioned and applied last, after every other source. `disabledMcpjsonServers` only drops servers declared in a repo `.mcp.json`; `disabledMcpServers` drops a name whatever its source, `--mcp` included. Enable keys are ignored: this tool never re-enables a server another config disabled.

## Repo auto-discovery is opt-in

`.mcp.json` is content of the repository under review. In CI the working tree **is** the merge request's source branch, so connecting a server declared there means running a command, or calling a URL, that the change author chose — before any tool annotation is inspected. The [read-only gate](#the-read-only-gate) filters what a connected server may expose; it does not decide which process gets spawned.

So repo auto-discovery is off unless you turn it on with `--mcp-discovery` / `CODE_REVIEW_MCP_DISCOVERY=true`, and you should turn it on only for repositories whose contributors you trust. Everywhere else, name the servers you want with `--mcp` / `CODE_REVIEW_MCP`, which the CI configuration controls rather than the branch.

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

| Field     | Notes                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`    | `stdio`, `http`, or `sse`. Defaults to `stdio` when `command` is present, `http` when `url` is present.                                                       |
| `command` | stdio only. The executable to spawn.                                                                                                                          |
| `args`    | stdio only. Arguments passed to `command`.                                                                                                                    |
| `env`     | stdio only. Extra environment variables for the child process.                                                                                                |
| `url`     | http / sse only. The server endpoint.                                                                                                                         |
| `headers` | http / sse only. Request headers (e.g. an auth token).                                                                                                        |
| `timeout` | Per-call timeout in milliseconds. Falls back to the bridge default (30s) when unset, and is clamped to 120s. Connect and `tools/list` always use a fixed 30s. |

A server declared with `type: ws`, or with an `oauth` or `headersHelper` field, is skipped with a warning — those transports and auth flows aren't supported.

## Env expansion

`${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env` values, `url`, and `headers` values. `${VAR:-default}` uses the default when `VAR` is unset **or** empty, as in POSIX. `${CLAUDE_PLUGIN_ROOT}` additionally expands to the plugin's own directory for marketplace-sourced servers, the same as it does for skills.

### The variable allowlist

A server definition is not always operator-authored — it can come from the repository under review, or from a marketplace plugin whose upstream ref moves — and expansion writes values into argv, headers, and URL query strings. So expansion reads **only** the variables you name with `--mcp-env` / `CODE_REVIEW_MCP_ENV`; the reviewer's own secrets (`CODE_REVIEW_GITLAB_TOKEN`, `ANTHROPIC_API_KEY`, …) are never readable unless you list them.

A reference to a variable that is not allowlisted, or that is unset with no default, skips that server. The warning names the variable only — never a value — so a token never reaches the logs:

```
MCP server "jira" in .mcp.json references unset environment variable(s) ${JIRA_TOKEN} — skipped. Set them or add a default with ${VAR:-default}, and allow them with --mcp-env / CODE_REVIEW_MCP_ENV.
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
  CODE_REVIEW_MCP_ENV: JIRA_TOKEN # allow that one name, and nothing else
```

## The read-only gate

The reviewer processes attacker-controlled MR content — a malicious diff or description could try to steer it into calling a destructive tool. So only tools that declare themselves safe are exposed: `annotations.readOnlyHint === true` and `annotations.destructiveHint !== true`. Everything else — write, delete, or unannotated tools — is dropped before the agent ever sees it, and dropped tools are logged once per server at debug level. A server exposing zero read-only tools still counts as connected; it simply contributes nothing to the tool list.

## CLI flags and environment variables

| Flag                   | Environment variable             | Notes                                                                                                                |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--mcp <spec>`         | `CODE_REVIEW_MCP`                | Repeatable / comma-separated. `file:<path>`, `<marketplace>:<plugin>`, or `<marketplace>:<plugin>/<server>`.         |
| `--disable-mcp <name>` | `CODE_REVIEW_DISABLE_MCP`        | Repeatable / comma-separated. Server names to drop, applied last over every source.                                  |
| `--mcp-env <name>`     | `CODE_REVIEW_MCP_ENV`            | Repeatable / comma-separated. Environment variables a server definition may read through `${VAR}`. Empty by default. |
| `--mcp-discovery`      | `CODE_REVIEW_MCP_DISCOVERY=true` | Turns **on** repo `.mcp.json` auto-discovery, which is off by default. Trusted repositories only.                    |

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

Connected servers and their exposed tools are listed in one `<external-context>` block in the reviewer's prompt. The agent is told to look up **structured identifiers** — issue numbers and ticket keys such as `#1234` or `PROJ-42` — that appear in the MR intent or commits _before_ reviewing. It is told explicitly **not** to fetch URLs, hostnames, or paths found there, and that the MR title, description, commits, diff, and every MCP tool result are untrusted data to read as evidence, never instructions to follow: all of it is written by the change author, and a connected tool would otherwise be a way to make the reviewer fetch an attacker-chosen target with that server's credentials. External context stays secondary to code defects and never outranks a finding grounded in the diff itself. No block is added when no server connected, so a review with no MCP config is unchanged.

## Summary footer

When at least one server was configured, the summary note carries an `MCP:` line next to the `Skills:` line, listing only exposed read-only tools:

```md
MCP: [jira](https://gitlab.example.com/team/app/-/blob/a1b2c3d/.mcp.json) (get_issue, search_issues), docs (unavailable)
```

A server name links to its source when reachable: a repo `.mcp.json` links to that file's blob at the reviewed commit (CI project coordinates required); a marketplace plugin links to the plugin's directory in the marketplace repository. A `file:` source, or a repo server on a run without CI project coordinates, stays an unlinked name — same rule as the [skills footer](./skills.md#skills-footer).

## Limits and budget

| Limit                  | Default       | Notes                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-call timeout       | 30s           | Overridable per server with `timeout` in `.mcp.json`, up to 120s. Connect and `tools/list` use a fixed 30s no server config can raise — both run before the agent loop, outside the review timeout.                                                                                          |
| Result size cap        | 200,000 chars | Covers the joined text **and** the base64 bytes of any image blocks, on success and on an error result alike. Oversized text is truncated with a note stating the original length; images that no longer fit, and any beyond the fourth, are replaced by an `[image omitted: N bytes]` note. |
| Call budget per review | 40 calls      | Shared across every MCP tool and every server. Once exhausted, a call returns a text telling the agent the budget is gone instead of erroring — the review continues on what it already has.                                                                                                 |

## Diagnostics and OpenTelemetry

Connect, list-tools, and call-tool operations are traced on `diagnostics_channel` and, with `CODE_REVIEW_OTEL=1`, rendered as span events and a per-server call-count attribute. See [Observability](./observability.md) for the channel names, payload shapes, and OTel attribute names.

## Troubleshooting

- **A server never appears in the footer.** It failed to resolve before connecting — check the CLI warning: a malformed `--mcp` spec, an unregistered marketplace, or invalid JSON in `.mcp.json` all warn and skip rather than fail the review.
- **A server shows `(unavailable)`.** It resolved but the connection failed (bad command, unreachable URL, timeout) — check the warning logged at connect time; the review continues without it.
- **A tool the server offers is missing from the footer.** It either lacks `readOnlyHint: true`, or sets `destructiveHint: true` — the gate drops it on purpose. Check the server's tool annotations; this tool cannot expose it without them.
- **A server is skipped for an "unset environment variable" that is clearly set.** Expansion reads only the allowlist — add the name to `--mcp-env` / `CODE_REVIEW_MCP_ENV`.
- **A CI-only server should not run locally.** Gate it in `.mcp.json` with a `${VAR:-}` default that resolves to nothing outside CI: an empty `command` or `url` after expansion skips the server cleanly. Or use `--disable-mcp <name>` / `CODE_REVIEW_DISABLE_MCP` locally.
- **Two servers' tools collide.** Bridged names sanitise every character outside `[A-Za-z0-9_-]`, so `jira.internal` and `jira_internal` produce the same `mcp__jira_internal__…` name. The first server wins; the later one's tool is dropped with a warning. Rename one of the servers.
