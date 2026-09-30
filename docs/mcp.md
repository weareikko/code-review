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

| Field     | Notes                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`    | `stdio`, `http`, or `sse`. Defaults to `stdio` when `command` is present, `http` when `url` is present. An `sse` server is parsed but reported unavailable — see below. |
| `command` | stdio only. The executable to spawn.                                                                                                                                    |
| `args`    | stdio only. Arguments passed to `command`.                                                                                                                              |
| `env`     | stdio only. Extra environment variables for the child process. The child inherits only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, and `USER` from the reviewer.        |
| `url`     | http / sse only. The server endpoint.                                                                                                                                   |
| `headers` | http / sse only. Request headers (e.g. an auth token).                                                                                                                  |
| `timeout` | Per-call timeout in milliseconds. Falls back to the bridge default (30s) when unset, and is clamped to 120s. Connect and `tools/list` always use a fixed 30s.           |

A server declared with `type: ws`, or with an `oauth` or `headersHelper` field, is skipped with a warning — those transports and auth flows aren't supported.

A server declared with `type: sse` resolves, but the MCP client ([`@earendil-works/pi-mcp`](https://www.npmjs.com/package/@earendil-works/pi-mcp)) implements only streamable HTTP, so the server shows as `(unavailable)` with the warning `legacy SSE transport is not supported; use the server's streamable HTTP endpoint`. Point `url` at the server's streamable HTTP endpoint and set `type: http`.

## Env expansion

`${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env` values, `url`, and `headers` values. `${VAR:-default}` uses the default when `VAR` is unset **or** empty, as in POSIX. `${CLAUDE_PLUGIN_ROOT}` additionally expands to the plugin's own directory for marketplace-sourced servers, the same as it does for skills.

A header whose value expands to an empty or whitespace-only string is **dropped**, not sent: `"Authorization": "${API_KEY:-}"` with no key set means no `Authorization` header at all, rather than a malformed empty one some servers reject. `env` values for stdio servers are kept as-is — an empty environment variable is a meaningful, distinct value there.

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

### From a public marketplace

Anthropic publishes a plugin marketplace with ready-made servers. This repository's own self-review loads `github` from it:

```yml
env:
  CODE_REVIEW_MARKETPLACES: 'anthropic=https://github.com/anthropics/claude-plugins-official.git#fbe07fb6ce7d51d8e86ca6efdf050059894cdb80'
  CODE_REVIEW_MCP: 'anthropic:github'
  CODE_REVIEW_MCP_DISCOVERY: 'true'
  GITHUB_PERSONAL_ACCESS_TOKEN: ${{ github.token }}
  CODE_REVIEW_MCP_ENV: GITHUB_PERSONAL_ACCESS_TOKEN
```

**Pin the ref.** A marketplace declared with no `#<ref>` fragment resolves the remote's default branch on every run, so each review clones whatever is on that third-party branch at that moment and connects to the URL it names, carrying whatever credentials the allowlist exposes. Anyone who can land a commit on that branch can then repoint the server. Pin a tag or a commit SHA, as above.

**Read the plugin's `.mcp.json` before you rely on it.** The header names, the URL, and the variables a plugin expects are upstream facts. At the pinned commit, the `github` plugin reads `${GITHUB_PERSONAL_ACCESS_TOKEN}`, so the workflow maps the job token to that name and allowlists it. The same marketplace's `context7` plugin points at `https://mcp.context7.com/mcp?client=claude-code-plugin`, and that endpoint requires an API key even though the plain `https://mcp.context7.com/mcp` URL is anonymous; its `${CONTEXT7_API_KEY:-}` header expands to nothing and is dropped by the empty-header rule above, and the server then answers "Authentication required". This repository therefore keeps `context7` in `.mcp.json` with the anonymous URL and does not load it from the marketplace.

The marketplace `github` definition carries only an `Authorization` header, with no `X-MCP-Readonly: true`, so the connection is write-capable server side; the read-only gate on tool annotations is what keeps the reviewer to read-only tools. When you control the definition, add the server-side guard as well, as the repo's `.mcp.json` entry does for local sessions.

A marketplace server overrides an auto-discovered `.mcp.json` server of the same name, so a repository can keep an entry in `.mcp.json` for local editor sessions and still have CI connect to the marketplace copy. That is why `github` appears in both places here.

## Prompt context

Connected servers and their exposed tools are listed in one `<external-context>` block in the reviewer's prompt. The agent is told to look up **structured identifiers** — issue numbers and ticket keys such as `#1234` or `PROJ-42` — that appear in the MR intent or commits _before_ reviewing. It is told explicitly **not** to fetch URLs, hostnames, or paths found there, and that the MR title, description, commits, diff, and every MCP tool result are untrusted data to read as evidence, never instructions to follow: all of it is written by the change author, and a connected tool would otherwise be a way to make the reviewer fetch an attacker-chosen target with that server's credentials. External context stays secondary to code defects and never outranks a finding grounded in the diff itself. No block is added when no server connected, so a review with no MCP config is unchanged.

## Verify stage

At `verify`/`full` depth the verifiers do **not** get the MCP tools: one external
lookup per review happens in Find. What those tools returned during Find is
replayed to every verifier as an `<external-context-results>` block in the cached
system prompt, next to the MR `<intent>` block — capped at 6,000 characters, most
recent results kept, each result flattened to one line and truncated with a note.
Without it a verifier dropped findings whose proof cites an issue or document
Find had read. The same untrusted-data rule applies there, and external context
never raises a severity above what the code supports. See
[multi-stage review](./multi-stage-review.md#what-verify-sees).

## Summary footer

When at least one server was configured, the summary note carries an `MCP:` line next to the `Skills:` line, reporting how many tool calls the reviewer made against each server:

```md
MCP: [jira](https://gitlab.example.com/team/app/-/blob/a1b2c3d/.mcp.json) (2 calls), [context7](https://gitlab.example.com/tools/ikko-tools/-/tree/main/plugins/dev) (unused), docs (unavailable)
```

`unused` is a server that connected but was never called; `unavailable` is one that failed to connect. The list of exposed read-only tools is no longer rendered here — it stays in the usage artifact (`review-usage.json`) under each server's `exposedTools`.

A server name links to its source when reachable: a repo `.mcp.json` links to that file's blob at the reviewed commit (CI project coordinates required); a marketplace plugin links to the plugin's directory in the marketplace repository. A `file:` source, or a repo server on a run without CI project coordinates, stays an unlinked name — same rule as the [skills footer](./skills.md#skills-footer).

## Limits and budget

| Limit                  | Default       | Notes                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-call timeout       | 30s           | Overridable per server with `timeout` in `.mcp.json`, up to 120s. Connect and `tools/list` use a fixed 30s no server config can raise — both run before the agent loop, outside the review timeout.                                                                                          |
| Result size cap        | 200,000 chars | Covers the joined text **and** the base64 bytes of any image blocks, on success and on an error result alike. Oversized text is truncated with a note stating the original length; images that no longer fit, and any beyond the fourth, are replaced by an `[image omitted: N bytes]` note. |
| Call budget per review | 40 calls      | Shared across every MCP tool and every server. Once exhausted, a call returns a text telling the agent the budget is gone instead of erroring — the review continues on what it already has.                                                                                                 |

## Library usage

`runReview` resolves MCP servers from the sources above. A library caller that already has its server configs — or that wants to drive a server over a transport of its own, as the eval suite does with an in-memory fake — replaces the connect step with the `connectMcp` option:

```ts
import { connectMcpServers, runReview, type McpServerConfig } from '@weareikko/code-review';

const tracker: McpServerConfig = {
  name: 'tracker',
  type: 'stdio',
  command: 'tracker-mcp',
  args: [],
  env: {},
  headers: {},
  source: { kind: 'file', path: 'tracker.json' },
};

await runReview(config, {
  diff,
  connectMcp: (_resolved, options) =>
    connectMcpServers([tracker], { ...options, createTransport: () => myTransport }),
});
```

The hook receives the configs resolved from the CLI/repo sources and the options `runReview` would have passed (logger, run id). Return any `McpConnection`: the read-only gate, the call budget, the result cap, and the summary footer all work the same on what it exposes. `createTransport` is the seam for a transport the bridge would not build itself — any `McpTransport` from `@earendil-works/pi-mcp`, such as the in-memory pair from `@earendil-works/pi-mcp/testing`; omit it and `connectMcpServers` builds the real stdio or streamable HTTP transport for each config.

### Codemode exposure (experimental)

By default each read-only tool is declared to the model as `mcp__<server>__<tool>`. Pass `mcpExposure: 'codemode'` to `runReview` to declare one `codemode` tool instead: the model writes a JavaScript script that calls the bridged tools as `await tools.<name>(args)` in a QuickJS sandbox (`@earendil-works/pi-codemode`) that has no network, timers, or modules. Only what the script returns or prints reaches the model. Every nested call goes through the bridged tool, so the read-only gate, the call budget, the per-call result cap, and the `mcp.call` trace apply unchanged; the script output is capped with the same result cap. A script has a 60 s deadline and a 64 MiB heap. Verifiers get no `codemode` tool and read the nested results Find collected, as in direct mode. There is no CLI flag or environment variable for this option yet.

## Diagnostics and OpenTelemetry

Connect, list-tools, and call-tool operations are traced on `diagnostics_channel` and, with `CODE_REVIEW_OTEL=1`, rendered as span events and per-server / aggregate call-count attributes. See [Observability](./observability.md) for the channel names, payload shapes, and OTel attribute names.

## Troubleshooting

- **A server never appears in the footer.** It failed to resolve before connecting — check the CLI warning: a malformed `--mcp` spec, an unregistered marketplace, or invalid JSON in `.mcp.json` all warn and skip rather than fail the review.
- **A server shows `(unavailable)`.** It resolved but the connection failed (bad command, unreachable URL, timeout) — check the warning logged at connect time; the review continues without it.
- **A tool the server offers is missing from `exposedTools`.** It either lacks `readOnlyHint: true`, or sets `destructiveHint: true` — the gate drops it on purpose. Check the server's tool annotations; this tool cannot expose it without them.
- **A server is skipped for an "unset environment variable" that is clearly set.** Expansion reads only the allowlist — add the name to `--mcp-env` / `CODE_REVIEW_MCP_ENV`.
- **A CI-only server should not run locally.** Gate it in `.mcp.json` with a `${VAR:-}` default that resolves to nothing outside CI: an empty `command` or `url` after expansion skips the server cleanly. Or use `--disable-mcp <name>` / `CODE_REVIEW_DISABLE_MCP` locally.
- **Two servers' tools collide.** Bridged names sanitise every character outside `[A-Za-z0-9_-]`, so `jira.internal` and `jira_internal` produce the same `mcp__jira_internal__…` name. The first server wins; the later one's tool is dropped with a warning. Rename one of the servers.
