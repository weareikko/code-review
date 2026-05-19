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
  --api-key "$GITLAB_REVIEW_API_KEY" \
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
  script:
    - npx @ikko-dev/gitlab-review
  artifacts:
    when: always
    paths:
      - gitlab-review.md
      - review-comments.json
      - review-usage.json
```

## Environment variables

The CLI auto-resolves values from CI variables and common token/key names.

| Variable                       | Purpose                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `CI_PROJECT_ID`                | Default for `--project`                                             |
| `CI_MERGE_REQUEST_IID`         | Default for `--mr`                                                  |
| `CI_SERVER_URL`                | Default for `--gitlab-url`                                          |
| `CI_SERVER_HOST`               | Fallback for `--gitlab-url` as `https://$CI_SERVER_HOST`            |
| `GITLAB_TOKEN`                 | Preferred GitLab API token (`PRIVATE-TOKEN`)                        |
| `GLAB_CLI_TOKEN`               | Fallback GitLab API token (`PRIVATE-TOKEN`)                         |
| `CI_JOB_TOKEN`                 | Fallback token (`JOB-TOKEN`)                                        |
| `GITLAB_PRIVATE_TOKEN`         | Fallback token (`PRIVATE-TOKEN`)                                    |
| `GITLAB_REVIEW_API_KEY`        | Preferred AI API key                                                |
| `ANTHROPIC_API_KEY`            | Fallback AI API key                                                 |
| `CLAUDE_API_KEY`               | Fallback AI API key                                                 |
| `GITLAB_REVIEW_MODEL`          | Default for `--model`                                               |
| `GITLAB_REVIEW_MIN_SEVERITY`   | Default for `--min-severity`                                        |
| `GITLAB_REVIEW_THINKING_LEVEL` | Default for `--thinking`                                            |
| `GITLAB_REVIEW_POSTING_MODE`   | Default for `--posting-mode`                                        |
| `GITLAB_REVIEW_POST_SUMMARY`   | Set to `false`/`0` to skip the MR-level summary note                |
| `GITLAB_REVIEW_FORCE_REVIEW`   | Set to `true`/`1` to review even if the commit was already reviewed |

## Flags

| Flag                     | Description                                            | Default                                                                  |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `--project <id>`         | GitLab project ID/path                                 | `CI_PROJECT_ID`                                                          |
| `--mr <iid>`             | Merge request IID                                      | `CI_MERGE_REQUEST_IID`                                                   |
| `--gitlab-url <url>`     | GitLab URL                                             | `CI_SERVER_URL` or `https://${CI_SERVER_HOST}`                           |
| `--gitlab-token <token>` | GitLab token                                           | `GITLAB_TOKEN`, `GLAB_CLI_TOKEN`, `CI_JOB_TOKEN`, `GITLAB_PRIVATE_TOKEN` |
| `--api-key <key>`        | API key passed to the review agent                     | `GITLAB_REVIEW_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`           |
| `--model <provider/id>`  | Model passed to the review agent                       | `GITLAB_REVIEW_MODEL` or `anthropic/claude-sonnet-4-5`                   |
| `--min-severity <level>` | `info`, `warn`, `critical`                             | `GITLAB_REVIEW_MIN_SEVERITY` or `info`                                   |
| `--thinking <level>`     | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`     | `GITLAB_REVIEW_THINKING_LEVEL` or `off`                                  |
| `--posting-mode <mode>`  | `direct` or `draft` (atomic bulk publish)              | `GITLAB_REVIEW_POSTING_MODE` or `direct`                                 |
| `--no-summary`           | Skip posting/updating the MR-level summary note        | summary posting is on by default                                         |
| `--force-review`         | Review even if the current commit was already reviewed | `GITLAB_REVIEW_FORCE_REVIEW` or `false`                                  |
| `--review-file <path>`   | Raw `gitlab-review` output file                        | `gitlab-review.md`                                                       |
| `--output <path>`        | Generated payload artifact file                        | `review-comments.json`                                                   |
| `--cwd <path>`           | Working directory                                      | `process.cwd()`                                                          |
| `--dry-run`              | Generate artifacts and skip posting                    | `false`                                                                  |
| `--no-post`              | Same behavior as `--dry-run`                           | `false`                                                                  |
| `--help`, `-h`           | Show help                                              | -                                                                        |
| `--version`, `-v`        | Show version                                           | -                                                                        |

`--thinking` controls extended thinking on the underlying agent. Thinking tokens are billed at the model's output token rate, so higher levels cost more — the `Review usage:` line and `review-usage.json` reflect that cost.

`--posting-mode draft` creates GitLab draft notes for every fresh comment and publishes them atomically via `POST /draft_notes/bulk_publish`. The reviewer either appears fully on the MR or not at all, instead of leaking partial state if the job is interrupted. If a draft creation fails mid-flight, the run sweeps the partial drafts before reporting the failure; if the job is killed before that, the next run's orphan cleanup picks them up. Requires a GitLab version that exposes the `draft_notes` and `bulk_publish` endpoints (≥ 15.10) and a token whose user can own draft notes — keep `direct` for older self-hosted instances or restricted tokens. `bulk_publish` publishes _all_ of the current user's drafts on the MR, so use a dedicated bot account if multiple processes may share the token.

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

The CLI ships an opt-in bridge that subscribes to the same diagnostics channels and emits OpenTelemetry spans **and** the standardized GenAI client metrics tagged with the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (`gen_ai.*`). Set `GITLAB_REVIEW_OTEL=1` to enable it — the OTel runtime is bundled, no extra installs required.

The bridge records `gen_ai.client.operation.duration` and `gen_ai.client.token.usage` histograms alongside the spans, so Grafana Application Observability / AI Observability (and any other OTel-compliant LLM observability surface that's driven off these metric names) auto-discovers the service from its metrics without any dashboard import.

Exporter selection follows the standard `OTEL_*` env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, …). Anything that ingests OTLP works: Tempo, Mimir, Jaeger, Datadog, Honeycomb, SigNoz, or [Grafana Cloud AI Observability (Sigil)](https://grafana.com/docs/grafana-cloud/machine-learning/ai-observability/).

Example pointing at Grafana Sigil:

```yml
variables:
  GITLAB_REVIEW_OTEL: '1'
  OTEL_EXPORTER_OTLP_ENDPOINT: '$SIGIL_ENDPOINT'
  OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer $SIGIL_TOKEN'
  OTEL_SEMCONV_STABILITY_OPT_IN: 'gen_ai_latest_experimental'
```

Span shape:

- `invoke_workflow gitlab-review` — root span per run, carrying `gitlab.project_id`, `gitlab.mr_iid`, comment counters, and `gen_ai.*` totals once the reviewer has finished.
- `invoke_agent gitlab-review` — wraps the agent call. Tagged with `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.operation.name=invoke_agent`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, and `gen_ai.usage.cost.*_usd` (cost is not yet standardized in the GenAI semconv, so it sits under a clearly namespaced custom attribute).
- `gitlab-review.<phase>` — one span per remaining phase (`gitlab.get_merge_request`, `git.get_merge_diff`, `gitlab.post_comments`, …) so latency and error rates per phase show up in Tempo / Grafana.

When the env var is not set, the bridge is a no-op and `@opentelemetry/*` is never imported (the modules are dynamic-loaded behind the env check, so unsetting the flag pays no startup cost).

Library callers with pre-existing `TracerProvider`/`MeterProvider` can share them by injecting a runtime instead of letting the bridge boot its own `NodeSDK`:

```js
import { metrics, trace } from '@opentelemetry/api';
import { startOtelBridge } from '@ikko-dev/gitlab-review';

await startOtelBridge({
  runtime: {
    tracerProvider: trace.getTracerProvider(),
    meterProvider: metrics.getMeterProvider(),
    shutdown: async () => {},
  },
});
```

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

Reviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) for commit <sha>.
```

If a later CI job sees that the current MR head commit already appears in that footer, it skips the agent run to avoid producing a different review for the same diff. Use `--force-review` or `GITLAB_REVIEW_FORCE_REVIEW=true` to bypass the guard. The summary upsert runs in both `direct` and `draft` posting modes (it always uses the regular notes endpoints — the atomic bulk-publish flow is reserved for inline comments).

Disable with `--no-summary` or `GITLAB_REVIEW_POST_SUMMARY=false`. With `--dry-run`/`--no-post`, the summary is parsed but not posted, and the reviewed-commit skip guard is not applied.

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

The review agent runs against pinned `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` versions, so published builds keep a deterministic reviewer runtime.
