# @ikko-dev/gitlab-review

[![NPM Version](https://img.shields.io/npm/v/@ikko-dev/gitlab-review.svg?style=flat&colorB=3e63dd&colorA=414853)](https://www.npmjs.com/package/@ikko-dev/gitlab-review/)
[![Downloads](https://img.shields.io/npm/dm/@ikko-dev/gitlab-review?style=flat&colorB=3e63dd&colorA=414853)](https://www.npmjs.com/package/@ikko-dev/gitlab-review/)
[![Size](https://img.shields.io/bundlephobia/minzip/@ikko-dev/gitlab-review?style=flat&colorB=3e63dd&colorA=414853&label=size)](https://bundlephobia.com/package/@ikko-dev/gitlab-review)
![Codecov](https://img.shields.io/codecov/c/github/ikko-dev/gitlab-review?style=flat&colorB=3e63dd&colorA=414853)

Run an agent-driven code review in GitLab CI, parse inline comments, post deduplicated merge request discussions, and report per-run token usage and cost.

## Requirements

- Node.js `>=24`
- `git` available in the runtime
- A pipeline running in a merge request context (`CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`)

## Install / Run

Run without installing:

```bash
npx @ikko-dev/gitlab-review
```

Or install in your project:

```bash
npm i -D @ikko-dev/gitlab-review
npx gitlab-review --help
```

### Binary entrypoint

This package exposes the `gitlab-review` binary through:

- `bin/gitlab-review.js` (runtime shim)
- `dist/cli.js` (compiled CLI)

## Usage

```bash
gitlab-review [options]
```

Common local dry-run:

```bash
gitlab-review \
  --project 123 \
  --mr 42 \
  --gitlab-url https://gitlab.example.com \
  --gitlab-token "$GITLAB_TOKEN" \
  --model anthropic/claude-sonnet-4-5 \
  --api-key "$ANTHROPIC_API_KEY" \
  --dry-run
```

## GitLab CI example

```yml
review:
  image: node:24
  stage: post
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: '0'
    # A model is required (no default). Provide its provider's key as a masked
    # CI/CD variable, e.g. ANTHROPIC_API_KEY.
    GITLAB_REVIEW_MODEL: anthropic/claude-sonnet-4-5
  script:
    - npx @ikko-dev/gitlab-review
  artifacts:
    when: always
    paths:
      - gitlab-review.md
      - review-comments.json
      - review-usage.json
```

## Providers

`gitlab-review` uses [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-ai) for model
access. Any registered provider can be selected with `--model provider/modelId`.

### Anthropic

```bash
ANTHROPIC_API_KEY=sk-ant-... npx @ikko-dev/gitlab-review --model anthropic/claude-sonnet-4-5
```

### OpenRouter

Multi-slash model IDs are supported — the provider is taken from the first segment only:

```bash
OPENROUTER_API_KEY=sk-or-... npx @ikko-dev/gitlab-review \
  --model openrouter/anthropic/claude-3-opus-20240229
```

### Google Gemini

```bash
GEMINI_API_KEY=... npx @ikko-dev/gitlab-review --model google/gemini-2.0-flash
```

### Ollama (local)

Point `OLLAMA_HOST` at your Ollama server. No API key is required:

```bash
OLLAMA_HOST=http://localhost:11434 \
GITLAB_REVIEW_MODEL=ollama/qwen2.5-coder:32b \
npx @ikko-dev/gitlab-review
```

`OLLAMA_HOST` defaults to `http://localhost:11434` when not set. Use `GITLAB_REVIEW_MAX_TOKENS`
to override the maximum output tokens when Ollama returns fewer tokens than expected.

### Generic OpenAI-compatible endpoint

Use `GITLAB_REVIEW_BASE_URL` to point the provider at any OpenAI-compatible API:

```bash
OPENAI_API_KEY=my-key \
GITLAB_REVIEW_BASE_URL=https://my-gateway.example.com/v1 \
npx @ikko-dev/gitlab-review --model openai/gpt-4o
```

## Environment variables

The CLI auto-resolves values from CI variables and common token/key names.

| Variable                                      | Purpose                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CI_PROJECT_ID`                               | Default for `--project`                                                                                                                                                                                            |
| `CI_MERGE_REQUEST_IID`                        | Default for `--mr`                                                                                                                                                                                                 |
| `CI_SERVER_URL`                               | Default for `--gitlab-url`                                                                                                                                                                                         |
| `CI_SERVER_HOST`                              | Fallback for `--gitlab-url` as `https://$CI_SERVER_HOST`                                                                                                                                                           |
| `GITLAB_TOKEN`                                | Preferred GitLab API token (`PRIVATE-TOKEN`)                                                                                                                                                                       |
| `GLAB_CLI_TOKEN`                              | Fallback GitLab API token (`PRIVATE-TOKEN`)                                                                                                                                                                        |
| `CI_JOB_TOKEN`                                | Fallback token (`JOB-TOKEN`)                                                                                                                                                                                       |
| `GITLAB_PRIVATE_TOKEN`                        | Fallback token (`PRIVATE-TOKEN`)                                                                                                                                                                                   |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` | AI API key for Anthropic / Claude models (oauth token takes precedence)                                                                                                                                            |
| `OPENAI_API_KEY`                              | AI API key for OpenAI models                                                                                                                                                                                       |
| `GEMINI_API_KEY`                              | AI API key for Google Gemini models                                                                                                                                                                                |
| `<PROVIDER>_API_KEY`                          | Provider-specific key for the selected model's provider (e.g. `OPENROUTER_API_KEY`, `GROQ_API_KEY`, …). The key is resolved against the model's provider only, so a key for one provider is never sent to another. |
| `GITLAB_REVIEW_MODEL`                         | Default for `--model`. A model is required — there is no implicit default; set this or pass `--model`.                                                                                                             |
| `GITLAB_REVIEW_BASE_URL`                      | Override the provider API base URL (e.g. a custom OpenAI-compatible endpoint). For Ollama, set `OLLAMA_HOST` instead.                                                                                              |
| `OLLAMA_HOST`                                 | Base URL for a local Ollama server (default: `http://localhost:11434`). Used automatically when `--model ollama/<model>` is set.                                                                                   |
| `GITLAB_REVIEW_MAX_TOKENS`                    | Override maximum output tokens for the model. `0` = model default.                                                                                                                                                 |
| `GITLAB_REVIEW_MIN_SEVERITY`                  | Default for `--min-severity`                                                                                                                                                                                       |
| `GITLAB_REVIEW_THINKING_LEVEL`                | Default for `--thinking`                                                                                                                                                                                           |
| `GITLAB_REVIEW_POSTING_MODE`                  | Default for `--posting-mode`                                                                                                                                                                                       |
| `GITLAB_REVIEW_POST_SUMMARY`                  | Set to `false`/`0` to skip the MR-level summary note                                                                                                                                                               |
| `GITLAB_REVIEW_FORCE_REVIEW`                  | Set to `true`/`1` to review even if the commit was already reviewed                                                                                                                                                |
| `GITLAB_REVIEW_SKILLS`                        | Comma-separated list of skill specs to enable. Bare names are built-in skills (e.g. `code-review`); `npm:`, `file:`, and `git:` / `git+ssh:` specs load external skills (see [Skills](#skills)).                   |
| `GITLAB_REVIEW_REFRESH_SKILLS`                | Set to `true`/`1` to re-clone `git:` / `git+ssh:` skills instead of reusing the on-disk cache                                                                                                                      |
| `GITLAB_REVIEW_OTEL`                          | Set to `1` to enable the OpenTelemetry bridge (generic OTLP spans + metrics)                                                                                                                                       |

### Namespacing provider/infra variables with `GITLAB_REVIEW_`

In a shared GitLab CI environment, the provider credentials and infra variables read by the AI SDK use generic, provider-standard names (`ANTHROPIC_API_KEY`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`, `OLLAMA_HOST`, ambient AWS/Vertex creds, …). To avoid collisions with unrelated jobs and make it obvious which variables belong to gitlab-review, you can optionally prefix any of them with `GITLAB_REVIEW_`. At startup, each `GITLAB_REVIEW_<NAME>` variable is exposed as `<NAME>`:

```
GITLAB_REVIEW_ANTHROPIC_API_KEY     → ANTHROPIC_API_KEY
GITLAB_REVIEW_CLOUDFLARE_API_KEY    → CLOUDFLARE_API_KEY
GITLAB_REVIEW_CLOUDFLARE_ACCOUNT_ID → CLOUDFLARE_ACCOUNT_ID
GITLAB_REVIEW_CLOUDFLARE_GATEWAY_ID → CLOUDFLARE_GATEWAY_ID
GITLAB_REVIEW_OLLAMA_HOST           → OLLAMA_HOST
GITLAB_REVIEW_GITLAB_TOKEN          → GITLAB_TOKEN
```

This is purely additive — unprefixed variables keep working unchanged. When both `GITLAB_REVIEW_<NAME>` and a plain `<NAME>` are set, the prefixed value wins, so the tool's scoped value overrides an unrelated CI-wide variable of the same name. The tool's own `GITLAB_REVIEW_*` settings listed above (e.g. `GITLAB_REVIEW_MODEL`, `GITLAB_REVIEW_OTEL`) are reserved and are never de-prefixed.

## Flags

| Flag                     | Description                                                                                                                                                                                         | Default                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--project <id>`         | GitLab project ID/path                                                                                                                                                                              | `CI_PROJECT_ID`                                                                                                            |
| `--mr <iid>`             | Merge request IID                                                                                                                                                                                   | `CI_MERGE_REQUEST_IID`                                                                                                     |
| `--gitlab-url <url>`     | GitLab URL                                                                                                                                                                                          | `CI_SERVER_URL` or `https://${CI_SERVER_HOST}`                                                                             |
| `--gitlab-token <token>` | GitLab token                                                                                                                                                                                        | `GITLAB_TOKEN`, `GLAB_CLI_TOKEN`, `CI_JOB_TOKEN`, `GITLAB_PRIVATE_TOKEN`                                                   |
| `--api-key <key>`        | AI API key. Required, except for providers with ambient credentials or local endpoints (e.g. Ollama).                                                                                               | The model provider's standard env var (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) |
| `--model <provider/id>`  | Model to use in `provider/modelId` format. Required — there is no default. Multi-slash IDs (e.g. `openrouter/anthropic/claude-3-opus`) are supported. Use `ollama/<model>` for local Ollama models. | `GITLAB_REVIEW_MODEL`                                                                                                      |
| `--base-url <url>`       | Override provider API base URL                                                                                                                                                                      | `GITLAB_REVIEW_BASE_URL` or `OLLAMA_HOST` (for Ollama models)                                                              |
| `--max-tokens <n>`       | Max output tokens (0 = model default)                                                                                                                                                               | `GITLAB_REVIEW_MAX_TOKENS` or `0`                                                                                          |
| `--min-severity <level>` | `info`, `warn`, `critical`                                                                                                                                                                          | `GITLAB_REVIEW_MIN_SEVERITY` or `info`                                                                                     |
| `--thinking <level>`     | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`                                                                                                                                                  | `GITLAB_REVIEW_THINKING_LEVEL` or `off`                                                                                    |
| `--posting-mode <mode>`  | `direct` or `draft` (atomic bulk publish)                                                                                                                                                           | `GITLAB_REVIEW_POSTING_MODE` or `direct`                                                                                   |
| `--no-summary`           | Skip posting/updating the MR-level summary note                                                                                                                                                     | summary posting is on by default                                                                                           |
| `--force-review`         | Review even if the current commit was already reviewed                                                                                                                                              | `GITLAB_REVIEW_FORCE_REVIEW` or `false`                                                                                    |
| `--review-file <path>`   | Raw `gitlab-review` output file                                                                                                                                                                     | `gitlab-review.md`                                                                                                         |
| `--output <path>`        | Generated payload artifact file                                                                                                                                                                     | `review-comments.json`                                                                                                     |
| `--cwd <path>`           | Working directory                                                                                                                                                                                   | `process.cwd()`                                                                                                            |
| `--skill <spec>`         | Enable a skill by name or external spec (`npm:`, `file:`, `git:` / `git+ssh:`); repeatable                                                                                                          | `GITLAB_REVIEW_SKILLS` or none                                                                                             |
| `--dry-run`              | Generate artifacts and skip posting                                                                                                                                                                 | `false`                                                                                                                    |
| `--no-post`              | Same behavior as `--dry-run`                                                                                                                                                                        | `false`                                                                                                                    |
| `--help`, `-h`           | Show help                                                                                                                                                                                           | -                                                                                                                          |
| `--version`, `-v`        | Show version                                                                                                                                                                                        | -                                                                                                                          |

`--thinking` controls extended thinking on the underlying agent. Thinking tokens are billed at the model's output token rate, so higher levels cost more — the `Review usage:` line and `review-usage.json` reflect that cost.

`--posting-mode draft` creates GitLab draft notes for every fresh comment and publishes them atomically via `POST /draft_notes/bulk_publish`. The reviewer either appears fully on the MR or not at all, instead of leaking partial state if the job is interrupted. If a draft creation fails mid-flight, the run sweeps the partial drafts before reporting the failure; if the job is killed before that, the next run's orphan cleanup picks them up. Requires a GitLab version that exposes the `draft_notes` and `bulk_publish` endpoints (≥ 15.10) and a token whose user can own draft notes — keep `direct` for older self-hosted instances or restricted tokens. `bulk_publish` publishes _all_ of the current user's drafts on the MR, so use a dedicated bot account if multiple processes may share the token.

## Skills

Skills are domain-specific review modules that sharpen the agent's focus on a particular class of bug or pattern. Each skill injects a focused instruction block and optional reference files into the system prompt.

### Built-in skills

| Name          | What it does                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-review` | Adversarial correctness review: finds real, demonstrable bugs only. Reports nothing without a concrete proof path (specific input → failure → observable symptom). Includes per-language reference files for JavaScript/TypeScript and PHP/Laravel. |

Enable a built-in skill with `--skill`:

```bash
gitlab-review --skill code-review
```

Or set it permanently via the environment variable:

```yml
variables:
  GITLAB_REVIEW_SKILLS: code-review
```

Multiple skills can be specified by repeating `--skill` or comma-separating values in `GITLAB_REVIEW_SKILLS`:

```bash
gitlab-review --skill code-review --skill my-custom-skill
```

### External skills

A `--skill` value can carry a protocol prefix to load a skill from outside the package. The resolved directory must contain a `SKILL.md` in the same [agentskills.io](https://agentskills.io) format as project skills.

| Spec                                           | Resolves to                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `code-review`                                  | A built-in skill bundled with the package                                        |
| `npm:@scope/pkg`                               | `node_modules/@scope/pkg` (walked up from the working dir; monorepo-hoist aware) |
| `npm:@scope/bundle/security`                   | A `security/` sub-directory inside an installed npm bundle                       |
| `file:./path/to/skill`                         | A local path (relative paths resolve from the working dir)                       |
| `git:https://host/group/project.git`           | A shallow clone of the repo's default branch                                     |
| `git:https://host/group/bundle.git#v1.2.0/sec` | A clone pinned to ref `v1.2.0`, loading the `sec/` sub-directory                 |
| `git+ssh://git@host/group/project.git`         | A clone over SSH (recommended for private GitLab repos)                          |

#### `git:` / `git+ssh:` skills

The repo is shallow-cloned at a **pinned ref** (a tag, branch, or commit). Append the ref — and an optional in-repo sub-directory — as a `#<ref>[/<subpath>]` fragment:

```bash
# repo root, default branch
gitlab-review --skill git:https://gitlab.example.com/tools/review-skill.git

# pin a tag, load a sub-directory from a multi-skill bundle
gitlab-review --skill 'git:https://gitlab.example.com/tools/skills.git#v1.2.0/security'

# private GitLab repo over SSH (preferred), pinned to a branch
gitlab-review --skill 'git+ssh://git@gitlab.example.com/tools/skills.git#main'
```

Following the project's SSH-over-HTTPS convention, prefer `git+ssh://git@<host>/<group>/<project>.git` for private GitLab remotes — authentication then uses the SSH key already available to the runner. The scp-style shorthand (`git@host:group/project.git`) is intentionally not accepted, since its `:` collides with the `#ref` fragment; use the full `git+ssh://` URI instead.

Clones are cached on disk under `${XDG_CACHE_HOME:-~/.cache}/gitlab-review/skills/`, keyed by URL and ref. A tag or commit ref is immutable, so the cache is reused indefinitely; a **branch** ref is also cached, so set `GITLAB_REVIEW_REFRESH_SKILLS=1` to re-clone when the branch has moved (or delete the cache directory).

### Project skills (auto-discovery)

Drop a skill directory anywhere between the git root and `cwd`. The reviewer walks up the tree and loads every skill it finds:

```
.agents/skills/<name>/SKILL.md      # preferred location
.claude/skills/<name>/SKILL.md      # alternative location
```

`SKILL.md` follows the [agentskills.io](https://agentskills.io) format — a YAML frontmatter block followed by the skill body:

```md
---
name: my-skill
description: One-line description shown in the summary footer.
---

Your skill instructions here. The reviewer reads these as part of its system prompt.
```

A `references/` subdirectory alongside `SKILL.md` is optional. Any files placed there are made available to the reviewer by path — the agent can read them on demand using its file-reading tool.

Project skills take precedence over built-in skills with the same name. A skill closer to `cwd` overrides one closer to the git root.

### Skills footer

When skills are active, their names appear in the MR summary note footer:

```md
Skills: `code-review`
```

## Artifacts

- `gitlab-review.md`: raw review text returned by the agent
- `review-comments.json`: generated comment objects including:
  - parsed comment payload
  - computed fingerprints
  - duplicate status
  - final GitLab discussion payload
- `review-usage.json`: token and cost breakdown for the run (`tokens.{input,output,cacheRead,cacheWrite,total}`, `cost.{input,output,cacheRead,cacheWrite,total}`, `model`)

The CLI also prints a one-line summary at the end of the run:

```
Review usage: 12,345 in / 678 out tokens — $0.0421 (anthropic/claude-sonnet-4-5)
```

Use these files for CI debugging and auditing.

## Diagnostics channels

`gitlab-review` publishes opt-in Node.js `diagnostics_channel` tracing events with no external telemetry dependency. Subscribers can listen before calling `run()` or from a Node preload/import hook before running the CLI.

Base tracing channel names:

- `@ikko-dev/gitlab-review:run`
- `@ikko-dev/gitlab-review:gitlab.get_merge_request`
- `@ikko-dev/gitlab-review:gitlab.get_latest_version`
- `@ikko-dev/gitlab-review:git.prepare_history`
- `@ikko-dev/gitlab-review:git.get_merge_diff`
- `@ikko-dev/gitlab-review:reviewer.run`
- `@ikko-dev/gitlab-review:review.parse`
- `@ikko-dev/gitlab-review:gitlab.get_discussions`
- `@ikko-dev/gitlab-review:comments.build`
- `@ikko-dev/gitlab-review:artifact.write_output`
- `@ikko-dev/gitlab-review:gitlab.post_comments`
- `@ikko-dev/gitlab-review:gitlab.upsert_summary`

Node emits tracing subchannels as `tracing:<base>:start`, `:end`, `:asyncStart`, `:asyncEnd`, and `:error`. Payloads include safe run metadata (`runId`, phase, project, MR, GitLab URL, model, severity, timings, comment counts, and sanitized `errorInfo`) and intentionally exclude tokens/API keys.

When `--posting-mode draft` is used, the `gitlab.post_comments` payload also exposes `draftsAbandoned`, `draftsCreated`, `draftsDeletedPrePublish`, and `draftsPublished` counters describing the draft lifecycle within the run.

The `git.get_merge_diff` payload exposes `diffFilesChanged`, `diffLinesAdded`, and `diffLinesRemoved`; the GitLab read phases expose `httpRequestMethod`, `httpUrl`, `httpStatusCode`, `httpResponseBodySize`, and `serverAddress` (no secrets — the token is sent in a request header, not the URL); and the top-level `run` payload exposes `postedBySeverity`, a per-severity breakdown of posted comments.

The `reviewer.run` payload exposes a `usage` field (`{ model, tokens, cost }`) once the agent has returned. The same `usage` is forwarded onto the top-level `run` payload so a subscriber on `run:asyncEnd` sees the final token and cost totals for the review.

```js
import { diagnosticChannels, run } from '@ikko-dev/gitlab-review';

const onStart = (ctx) => console.log('review started', ctx.runId);
const onEnd = (ctx) => console.log('review completed', ctx.durationMs, ctx.generated);
const onError = (ctx) => console.error('review failed', ctx.errorInfo);

diagnosticChannels.run.start.subscribe(onStart);
diagnosticChannels.run.asyncEnd.subscribe(onEnd);
diagnosticChannels.run.error.subscribe(onError);

await run(config);
```

### OpenTelemetry bridge

`GITLAB_REVIEW_OTEL=1` enables a bridge that subscribes to the diagnostics channels and emits **OTLP** spans, GenAI client metrics, and structured log records. The OTel runtime is bundled — no extra installs required.

Exporter selection follows the standard `OTEL_*` env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, …). Anything that ingests OTLP works: Tempo, Mimir, Loki, Jaeger, Datadog, Honeycomb, SigNoz, and so on.

#### Spans

The full trace hierarchy in Tempo is:

```
invoke_workflow gitlab-review
└── invoke_agent gitlab-review
    ├── gen_ai.agent.turn (turn 1)
    │   ├── execute_tool Read
    │   └── execute_tool Grep
    ├── gen_ai.agent.turn (turn 2)
    │   └── execute_tool Read
    └── gen_ai.agent.turn (turn N)
```

- `invoke_workflow gitlab-review` — root span per run, carrying `gitlab.project_id`, `gitlab.mr_iid`, comment counters, and `gen_ai.*` totals.
- `invoke_agent gitlab-review` — wraps the full agent call. Tagged with `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.operation.name=invoke_agent`, aggregate token and cost attributes.
- `gen_ai.agent.turn` — one child span per agent turn with per-turn token counts, cost, model, and stop reason.
- `execute_tool <name>` — one grandchild span per tool call (`gen_ai.tool.name`, `gen_ai.tool.call.id`). Error status is set on failed calls; failed calls also carry `process.exit_code`, and (only with content capture) `tool.stderr` and `tool.command`.
- `gitlab-review.<phase>` — one span per remaining phase (`gitlab.get_merge_request`, `git.get_merge_diff`, `gitlab.post_comments`, …) for latency and error rates.

GitLab API read spans (`gitlab.get_merge_request`, `gitlab.get_latest_version`, `gitlab.get_discussions`) carry stable OTel HTTP semantic-convention attributes — `http.request.method`, `http.response.status_code`, `url.full`, `http.response.body.size`, `server.address` — so API rate limits and 4xx/5xx responses are visible at the span level (the failing request's status is recorded even when the call throws). The `git.get_merge_diff` span carries `diff.files_changed`, `diff.lines_added`, and `diff.lines_removed` so duration and cost can be correlated with change size. The root `invoke_workflow` span carries `gitlab_review.run_id` (and `gen_ai.conversation.id`) so a trace can be joined to its metric series and log stream.

#### Metrics

The bridge emits two sets of metrics.

**GenAI client metrics** follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (`gen_ai.*`) and are emitted per LLM call:

| Metric                              | Unit    | Purpose                                           |
| ----------------------------------- | ------- | ------------------------------------------------- |
| `gen_ai.client.operation.duration`  | s       | Overall agent call duration                       |
| `gen_ai.client.token.usage`         | {token} | Token counts per turn by type                     |
| `gen_ai.client.cost`                | usd     | Cost per turn                                     |
| `gen_ai.client.time_to_first_token` | s       | TTFT per turn (recorded on first streaming event) |

**Review-level metrics** are emitted once per complete run (success or failure):

| Metric                                          | Type      | Labels                                                                                                                   |
| ----------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `gitlab_review_runs_total`                      | Counter   | `gitlab.project_path`, `gitlab.pipeline_source`, `gitlab_review.dry_run`, `gitlab_review.status`                         |
| `gitlab_review_errors_total`                    | Counter   | `gitlab.project_path`, `gitlab_review.dry_run`, `gitlab_review.status`, `error.type`                                     |
| `gitlab_review_run_duration_seconds`            | Histogram | `gitlab.project_path`, `gitlab.pipeline_source`, `gitlab_review.dry_run`, `gitlab_review.status`, `gen_ai.request.model` |
| `gitlab_review_total_cost_usd`                  | Histogram | `gitlab.project_path`, `gitlab_review.dry_run`, `gitlab_review.status`, `gen_ai.request.model`                           |
| `gitlab_review_comments_total`                  | Counter   | `gitlab.project_path`, `gitlab_review.dry_run`, `gitlab_review.comment.severity`                                         |
| `gitlab_review_drafts_published_total`          | Counter   | `gitlab.project_path`, `gitlab_review.dry_run`                                                                           |
| `gitlab_review_phase_duration_seconds`          | Histogram | `gitlab.project_path`, `gitlab_review.phase`, `gitlab_review.status`                                                     |
| `gitlab_review_llm_input_tokens_total`          | Counter   | `gitlab.project_path`, `gen_ai.request.model`                                                                            |
| `gitlab_review_llm_output_tokens_total`         | Counter   | `gitlab.project_path`, `gen_ai.request.model`                                                                            |
| `gitlab_review_llm_cache_read_tokens_total`     | Counter   | `gitlab.project_path`, `gen_ai.request.model`                                                                            |
| `gitlab_review_llm_cache_creation_tokens_total` | Counter   | `gitlab.project_path`, `gen_ai.request.model`                                                                            |

`gitlab_review.status` is `success`, `error`, or `timeout` (AbortError / ETIMEDOUT). `gitlab.project_path` is populated from `CI_PROJECT_PATH` when running inside a GitLab CI pipeline.

`gitlab_review_runs_total` increments exactly once per run, so review volume is `sum(increase(gitlab_review_runs_total[…]))` and the error rate is `gitlab_review_errors_total / gitlab_review_runs_total`. The unique per-run `run_id` is deliberately **not** a metric label — it would create one Prometheus/Mimir series per run (unbounded cardinality). `run_id` lives on spans and log records instead, which is where per-run correlation belongs.

Grafana Application Observability auto-discovers the service from its `gen_ai.*` metrics without any dashboard import. The `gitlab_review_*` metrics enable project-level Mimir queries such as `sum by (gitlab_project_path) (increase(gitlab_review_total_cost_usd_sum[7d]))` to track spend per repository.

#### Structured log records

Every record carries an `event.name` from a fixed taxonomy so logs can be filtered by event type:

| `event.name`              | Severity | When                  | Notable attributes                                                                      |
| ------------------------- | -------- | --------------------- | --------------------------------------------------------------------------------------- |
| `gitlab_review.started`   | INFO     | run phase opens       | `gitlab_review.run_id`, project/MR IDs, `gitlab_review.dry_run`, `gen_ai.request.model` |
| `gitlab_review.completed` | INFO     | run succeeds          | total cost, token counts, model, comment/duplicate counts, `gitlab_review.duration_ms`  |
| `gitlab_review.failed`    | ERROR    | run throws            | `error.type`, `error.message`, `gitlab_review.run_id`                                   |
| `gitlab_review.comment`   | INFO     | per generated comment | `gitlab_review.comment.file`, `…line`, `…severity`, `…is_duplicate`, body               |

The `gitlab_review.started` record is emitted before any work, so review duration can be computed from logs alone and stuck/hung runs are detectable even when no completion ever arrives. A failed run emits `gitlab_review.failed` at ERROR severity (never a success record), making every failure a single `severity=ERROR` query away. `error.message` has the run's own secret values — the GitLab token and the provider API key — scrubbed out before the record is emitted, in every encoding they might appear under (raw, URL/form-encoded, JSON-escaped, base64).

Log records land in Loki (or whichever OTLP log backend you target) and are correlated back to traces via the root span context (`trace_id`/`span_id`) and to metrics via `gitlab_review.run_id` / `gitlab.project_path`.

#### Loki stream labels

By default these records reach Loki with only `service_name` promoted to a stream label; everything else (`gitlab_project_path`, `gitlab_review_run_id`, …) is structured metadata, which requires a full scan to filter. To scope queries efficiently, promote the high-value fields to stream labels in your collector. In the OpenTelemetry Collector, the `loki` exporter reads hints from resource/log attributes:

```yaml
processors:
  attributes/loki:
    actions:
      - key: loki.attribute.labels
        value: gitlab_project_path, gitlab_review_run_id
        action: insert
```

The equivalent in Grafana Alloy's `otelcol.exporter.loki` / `loki.process` pipeline is a `stage.structured_metadata` or `stage.labels` block listing the same two fields. Keep the promoted set small — `gitlab_project_path` is low-cardinality and safe; `gitlab_review_run_id` is high-cardinality, so promote it only if your retention and stream limits allow, otherwise query it from structured metadata.

#### Grafana Cloud token scopes

For all three signals to reach their respective backends, the service account token used in `OTEL_EXPORTER_OTLP_HEADERS` must carry:

- `Traces Publisher` — writes to Tempo
- `Metrics Publisher` — writes to Mimir
- `Logs Publisher` — writes to Loki

A token missing any of these scopes will get a silent `401 Unauthorized: invalid scope requested` from the OTLP gateway. Set `OTEL_LOG_LEVEL=error` to surface export failures.

#### Disabling the bridge

When `GITLAB_REVIEW_OTEL` is not set, the bridge is a no-op and `@opentelemetry/*` is never imported (dynamic-loaded behind the env check, so unsetting the flag pays no startup cost).

#### Library injection

Library callers with pre-existing `TracerProvider`/`MeterProvider`/`LoggerProvider` can share them by injecting a runtime instead of letting the bridge boot its own `NodeSDK`:

```js
import { metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { startOtelBridge } from '@ikko-dev/gitlab-review';

await startOtelBridge({
  runtime: {
    tracerProvider: trace.getTracerProvider(),
    meterProvider: metrics.getMeterProvider(),
    loggerProvider: logs.getLoggerProvider(),
    shutdown: async () => {},
  },
});
```

## Review output format

Reviewer output is structured so each MR review reads the same way across runs and reviewers.

**Inline comments** use the [Conventional Comments](https://conventionalcomments.org/) shape:

```md
<label> [decoration]: <Subject — short, action-oriented>

<Discussion: 1-2 sentences on the defect and impact, then the fix (often a `suggestion` block).>
```

Allowed labels: `issue`, `suggestion`, `nitpick`, `question`, `todo`, `chore`, `note`, `thought`. Decorations: `(blocking)`, `(non-blocking)`, `(if-minor)`. Severity ↔ label mapping is fixed:

| `severity` field | Comment header                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| `CRITICAL`       | `issue (blocking): ...`                                                        |
| `WARN`           | `issue: ...` (unmarked, implicitly blocking)                                   |
| `INFO`           | `nitpick:` / `suggestion (non-blocking):` / `note:` / `question:` / `thought:` |

**Summary** follows a fixed skeleton (each section is omitted if empty):

```md
### Overview

<2-3 sentences: what the MR does and the verdict.>

### Findings

<N> issue (blocking) · <N> issue · <N> suggestion · <N> nitpick

- **<label>** — `path/to/file.ts:42` — <subject only — not the discussion>

### Notes

<Suppressed findings (with the commit/ADR they reference), unreviewed files, or anything inline comments cannot carry.>
```

When there are no findings, the summary is exactly: `No issues found in the reviewed diff.`

The Findings bullets restate only the subject of each inline comment — the discussion, impact, and fix live in the inline comment itself, not in the summary.

## MR-level summary note

In addition to inline discussions, the reviewer returns an overall `summary` (Markdown). The CLI posts it as a non-positional MR note — the same shape a human reviewer creates when typing in the MR comment box. The note carries a hidden marker:

```md
<!-- gitlab-review:summary -->
```

On subsequent runs the CLI finds the existing note by that marker and **updates it in place** via `PUT /merge_requests/:iid/notes/:id`, so the summary always reflects the latest review without piling up duplicates. The latest summary stays at the top of the note. When a note is updated, the previous latest summary is moved into a collapsed `<details>` section labeled `Previous review runs` instead of being erased; existing history is retained with a bounded limit of 10 previous runs.

The summary is upserted **before** inline comments are posted so it appears at the top of the MR activity feed. It appends footer metadata after a horizontal rule so reviewers can see the run cost and reviewed commit at a glance:

```md
---

Review usage: 12,345 in / 678 out tokens — $0.0421 (anthropic/claude-sonnet-4-5)

Skills: `code-review`

Reviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) for commit <sha>.
```

The `Skills:` line is only present when one or more skills were active for the run.

If a later CI job sees that the current MR head commit already appears in that footer, it skips the agent run to avoid producing a different review for the same diff. Use `--force-review` or `GITLAB_REVIEW_FORCE_REVIEW=true` to bypass the guard. The summary upsert runs in both `direct` and `draft` posting modes (it always uses the regular notes endpoints — the atomic bulk-publish flow is reserved for inline comments).

Disable with `--no-summary` or `GITLAB_REVIEW_POST_SUMMARY=false`. With `--dry-run`/`--no-post`, the summary is parsed but not posted, and the reviewed-commit skip guard is not applied.

## Inline comment footer

Each inline comment ends with a compact footer that mirrors the format used in the summary note:

```md
<sub>Reviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) for commit <sha>.</sub>
```

This lets developers see at a glance whether a comment was posted during the current review pass or an earlier one — useful when a long-lived MR accumulates comments across many commits.

The footer is appended to the **payload body only**. Fingerprints are computed from the original reviewer output before the footer is added, so deduplication is unaffected by the SHA changing between review runs.

## Duplicate prevention

Each generated comment body includes hidden markers:

```md
<!-- gitlab-review:fingerprint-primary:<hash> -->
<!-- gitlab-review:fingerprint-secondary:<hash> -->
```

Before posting, the CLI fetches existing MR discussions and skips comments where either fingerprint is already present. This prevents reposting across reruns and also prevents duplicates generated in the same run.

## Troubleshooting

- **`Node.js >=24 is required`**
  - Use `node:24` (or newer) in CI.
- **`Missing required configuration`**
  - Provide required flags or ensure CI vars are available (`CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, token, API key).
- **`--min-severity must be one of: info, warn, critical`**
  - Fix `--min-severity` or `GITLAB_REVIEW_MIN_SEVERITY`.
- **Git history errors / merge-base failures**
  - Set `GIT_DEPTH: 0`.
  - Ensure source and target branches are fetchable from `origin`.
- **GitLab API 401/403 when posting**
  - Ensure token has rights to read MR metadata/discussions and create MR discussions.
  - If using `CI_JOB_TOKEN`, ensure your GitLab project settings allow required API access.
- **No comments posted**
  - Check `review-comments.json` for `duplicate: true` or empty parsed comments.
  - Run with `--dry-run` and inspect `gitlab-review.md` formatting (`== Inline Comments ==`).

## Development / release

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Eval tests call the real LLM and require `ANTHROPIC_API_KEY` (or `GITLAB_REVIEW_API_KEY`) in a local `.env` file:

```bash
npm run test:evals
```

Override the model for cheaper/faster eval runs:

```bash
GITLAB_REVIEW_EVAL_MODEL=anthropic/claude-haiku-4-5-20251001 npm run test:evals
```

The review agent runs against pinned `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` versions, so published builds keep a deterministic reviewer runtime.

## Acknowledgements

`gitlab-review` builds on ideas and prior work from several projects:

- **[pi-reviewer](https://github.com/earendil-works/pi-reviewer)** — the original agent-driven code reviewer that `gitlab-review` grew out of. The agent runtime (`@earendil-works/pi-agent-core`), model abstraction (`@earendil-works/pi-ai`), and read-only coding tools (`@earendil-works/pi-coding-agent`) are all pi-reviewer infrastructure.
- **[Warden](https://warden.sentry.dev)** by Sentry — the skills architecture (per-skill instruction blocks, reference files loaded on demand by the agent, project-level discovery) takes direct inspiration from Warden's approach to composable, domain-specific review modules.
- **[agentskills.io](https://agentskills.io)** — the `SKILL.md` frontmatter format and multi-file skill layout (`references/`, `scripts/`, `assets/`) follow the agentskills.io open standard for portable agent skills.
