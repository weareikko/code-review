# Observability

← Back to the [README](../README.md)

> **Naming note.** The OTel identifiers are platform-neutral so one set of dashboards/queries works for both GitLab MRs and GitHub PRs: review-level metrics are `code_review_*`, application attributes are `code_review.*`, repository/change attributes follow the OpenTelemetry [VCS semantic conventions](https://opentelemetry.io/docs/specs/semconv/attributes-registry/vcs/) (`vcs.*`), CI attributes follow `cicd.*`, and source-control API phase/channel names are `scm.*` (e.g. `scm.get_merge_request`).
>
> **Breaking change.** These replaced the earlier `gitlab_review_*` / `gitlab.*` identifiers. Dashboards, alerts, and recording rules built on the old names must be updated (mapping in the [CHANGELOG](../CHANGELOG.md)); historical series keep their old names, so a query spanning the rename boundary sees a gap.
>
> Every metric, span, and log also carries two low-cardinality VCS discriminators so dashboards can filter by platform and instance: **`vcs.provider.name`** (`gitlab` | `github`, from the resolved `--platform`) and **`server.address`** (the instance host — e.g. `gitlab.com`, a self-hosted `gitlab.example.com`, or `github.com` — parsed from the server URL). These come from config, so they populate even outside CI.
>
> The remaining `vcs.*` / `cicd.*` attributes are sourced from **either** GitLab CI **or** GitHub Actions environment variables (whichever the run provides): `vcs.repository.name` from `CI_PROJECT_PATH` / `GITHUB_REPOSITORY`, `vcs.owner.name` from `CI_PROJECT_NAMESPACE` / `GITHUB_REPOSITORY_OWNER`, `vcs.ref.base.name` from `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` / `GITHUB_BASE_REF`, `cicd.pipeline.source` from `CI_PIPELINE_SOURCE` / `GITHUB_EVENT_NAME`, and — span/log only (per-repo cardinality) — `vcs.repository.url.full` from `CI_PROJECT_URL` / (`GITHUB_SERVER_URL` + `GITHUB_REPOSITORY`), `cicd.pipeline.run.id` from `CI_PIPELINE_ID` / `GITHUB_RUN_ID`, and `cicd.pipeline.task.run.id` from `CI_JOB_ID` / `GITHUB_JOB`. Outside CI they are omitted.

## Diagnostics channels

`code-review` publishes opt-in Node.js `diagnostics_channel` tracing events with no external telemetry dependency. Subscribers can listen before calling `run()` or from a Node preload/import hook before running the CLI.

Base tracing channel names:

- `@weareikko/code-review:run`
- `@weareikko/code-review:scm.get_merge_request`
- `@weareikko/code-review:scm.get_latest_version`
- `@weareikko/code-review:git.prepare_history`
- `@weareikko/code-review:git.get_merge_diff`
- `@weareikko/code-review:reviewer.run`
- `@weareikko/code-review:review.parse`
- `@weareikko/code-review:scm.get_discussions`
- `@weareikko/code-review:comments.build`
- `@weareikko/code-review:artifact.write_output`
- `@weareikko/code-review:scm.post_comments`
- `@weareikko/code-review:scm.upsert_summary`

Node emits tracing subchannels as `tracing:<base>:start`, `:end`, `:asyncStart`, `:asyncEnd`, and `:error`. Payloads include safe run metadata (`runId`, phase, project, MR, GitLab URL, model, severity, timings, comment counts, and sanitized `errorInfo`) and intentionally exclude tokens/API keys.

When `--posting-mode draft` is used, the `scm.post_comments` payload also exposes `draftsAbandoned`, `draftsCreated`, `draftsDeletedPrePublish`, and `draftsPublished` counters describing the draft lifecycle within the run.

The `git.get_merge_diff` payload exposes `diffFilesChanged`, `diffLinesAdded`, and `diffLinesRemoved`; the source-control (`scm.*`) read phases expose `httpRequestMethod`, `httpUrl`, `httpStatusCode`, `httpResponseBodySize`, and `serverAddress` (no secrets — the token is sent in a request header, not the URL); and the top-level `run` payload exposes `postedBySeverity`, a per-severity breakdown of posted comments.

The `reviewer.run` payload exposes a `usage` field (`{ model, tokens, cost }`) once the agent has returned. The same `usage` is forwarded onto the top-level `run` payload so a subscriber on `run:asyncEnd` sees the final token and cost totals for the review.

```js
import { diagnosticChannels, run } from '@weareikko/code-review';

const onStart = (ctx) => console.log('review started', ctx.runId);
const onEnd = (ctx) => console.log('review completed', ctx.durationMs, ctx.generated);
const onError = (ctx) => console.error('review failed', ctx.errorInfo);

diagnosticChannels.run.start.subscribe(onStart);
diagnosticChannels.run.asyncEnd.subscribe(onEnd);
diagnosticChannels.run.error.subscribe(onError);

await run(config);
```

### OpenTelemetry bridge

`CODE_REVIEW_OTEL=1` enables a bridge that subscribes to the diagnostics channels and emits **OTLP** spans, GenAI client metrics, and structured log records. The OTel runtime is bundled — no extra installs required.

Exporter selection follows the standard `OTEL_*` env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, …). Anything that ingests OTLP works: Tempo, Mimir, Loki, Jaeger, Datadog, Honeycomb, SigNoz, and so on.

#### Spans

The full trace hierarchy in Tempo is:

```
invoke_workflow code-review
└── invoke_agent code-review
    ├── gen_ai.agent.turn (turn 1)
    │   ├── execute_tool Read
    │   └── execute_tool Grep
    ├── gen_ai.agent.turn (turn 2)
    │   └── execute_tool Read
    └── gen_ai.agent.turn (turn N)
```

- `invoke_workflow code-review` — root span per run, carrying `vcs.repository.id`, `vcs.change.id`, comment counters, and `gen_ai.*` totals.
- `invoke_agent code-review` — wraps the full agent call. Tagged with `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.operation.name=invoke_agent`, aggregate token and cost attributes.
- `gen_ai.agent.turn` — one child span per agent turn with per-turn token counts, cost, model, and stop reason.
- `execute_tool <name>` — one grandchild span per tool call (`gen_ai.tool.name`, `gen_ai.tool.call.id`). Error status is set on failed calls; failed calls also carry `process.exit_code`, and (only with content capture) `tool.stderr` and `tool.command`.
- `code-review.<phase>` — one span per remaining phase (`scm.get_merge_request`, `git.get_merge_diff`, `scm.post_comments`, …) for latency and error rates.

Source-control API read spans (`scm.get_merge_request`, `scm.get_latest_version`, `scm.get_discussions`) carry stable OTel HTTP semantic-convention attributes — `http.request.method`, `http.response.status_code`, `url.full`, `http.response.body.size`, `server.address` — so API rate limits and 4xx/5xx responses are visible at the span level (the failing request's status is recorded even when the call throws). The `git.get_merge_diff` span carries `diff.files_changed`, `diff.lines_added`, and `diff.lines_removed` so duration and cost can be correlated with change size. The root `invoke_workflow` span carries `code_review.run_id` (and `gen_ai.conversation.id`) so a trace can be joined to its metric series and log stream.

#### Metrics

The bridge emits two sets of metrics.

**GenAI client metrics** follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (`gen_ai.*`) and are emitted per LLM call:

| Metric                                        | Unit    | Purpose                                           |
| --------------------------------------------- | ------- | ------------------------------------------------- |
| `gen_ai.client.operation.duration`            | s       | Overall agent call duration                       |
| `gen_ai.client.token.usage`                   | {token} | Token counts per turn by type                     |
| `gen_ai.client.operation.time_to_first_chunk` | s       | TTFT per turn (recorded on first streaming event) |

Provider is emitted as `gen_ai.provider.name` (the current semconv discriminator); the deprecated `gen_ai.system` is emitted alongside it during the transition. OTel does not standardize token **cost**, so per-turn cost is emitted as `code_review_llm_cost_usd` (histogram, USD, broken down by `gen_ai.token.type`) — a deliberate local extension kept out of the reserved `gen_ai.*` namespace so it cannot collide if the spec later defines a cost metric. Per-turn cost span attributes use the `code_review.cost.*_usd` keys for the same reason.

**Review-level metrics** are emitted once per complete run (success or failure):

| Metric                                        | Type      | Labels                                                                                                                 |
| --------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `code_review_runs_total`                      | Counter   | `vcs.repository.name`, `cicd.pipeline.source`, `code_review.dry_run`, `code_review.status`, `code_review.first_review` |
| `code_review_errors_total`                    | Counter   | `vcs.repository.name`, `code_review.dry_run`, `code_review.status`, `error.type`                                       |
| `code_review_run_duration_seconds`            | Histogram | `vcs.repository.name`, `cicd.pipeline.source`, `code_review.dry_run`, `code_review.status`, `gen_ai.request.model`     |
| `code_review_total_cost_usd`                  | Histogram | `vcs.repository.name`, `code_review.dry_run`, `code_review.status`, `gen_ai.request.model`                             |
| `code_review_comments_total`                  | Counter   | `vcs.repository.name`, `code_review.dry_run`, `code_review.comment.severity`                                           |
| `code_review_drafts_published_total`          | Counter   | `vcs.repository.name`, `code_review.dry_run`                                                                           |
| `code_review_phase_duration_seconds`          | Histogram | `vcs.repository.name`, `code_review.phase`, `code_review.status`                                                       |
| `code_review_llm_input_tokens_total`          | Counter   | `vcs.repository.name`, `gen_ai.request.model`                                                                          |
| `code_review_llm_output_tokens_total`         | Counter   | `vcs.repository.name`, `gen_ai.request.model`                                                                          |
| `code_review_llm_cache_read_tokens_total`     | Counter   | `vcs.repository.name`, `gen_ai.request.model`                                                                          |
| `code_review_llm_cache_creation_tokens_total` | Counter   | `vcs.repository.name`, `gen_ai.request.model`                                                                          |

`code_review.status` is `success`, `error`, or `timeout` (AbortError / ETIMEDOUT). `vcs.repository.name` is populated from `CI_PROJECT_PATH` (GitLab CI) or `GITHUB_REPOSITORY` (GitHub Actions) when running in CI.

`code_review_runs_total` increments exactly once per run, so review volume is `sum(increase(code_review_runs_total[…]))` and the error rate is `code_review_errors_total / code_review_runs_total`. The unique per-run `run_id` and the MR/PR change id are deliberately **not** metric labels — they would create one Prometheus/Mimir series per run/change (unbounded cardinality) and live on spans and log records instead.

Because a single MR/PR is re-reviewed on each push, `runs_total` counts _review runs_, not distinct MRs. The low-cardinality boolean `code_review.first_review` (true when no prior bot summary note exists on the MR/PR) bridges the gap without a per-change label: `sum(increase(code_review_runs_total{code_review_first_review="true"}[…]))` counts MRs/PRs newly entering review in the window, and pairing it with `code_review_total_cost_usd_sum` gives cost per MR/PR. `first_review="false"` is the re-review volume. (For an _exact_ distinct-MR count over an arbitrary window — including MRs first reviewed earlier — query the change id from spans/logs instead.)

Grafana Application Observability auto-discovers the service from its `gen_ai.*` metrics without any dashboard import. The `code_review_*` metrics enable project-level Mimir queries such as `sum by (vcs_repository_name) (increase(code_review_total_cost_usd_sum[7d]))` to track spend per repository.

#### Structured log records

Every record carries an `event.name` from a fixed taxonomy so logs can be filtered by event type:

| `event.name`            | Severity | When                  | Notable attributes                                                                   |
| ----------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------ |
| `code_review.started`   | INFO     | run phase opens       | `code_review.run_id`, project/MR IDs, `code_review.dry_run`, `gen_ai.request.model`  |
| `code_review.completed` | INFO     | run succeeds          | total cost, token counts, model, comment/duplicate counts, `code_review.duration_ms` |
| `code_review.failed`    | ERROR    | run throws            | `error.type`, `error.message`, `code_review.run_id`                                  |
| `code_review.comment`   | INFO     | per generated comment | `code_review.comment.file`, `…line`, `…severity`, `…is_duplicate`, body              |

The `code_review.started` record is emitted before any work, so review duration can be computed from logs alone and stuck/hung runs are detectable even when no completion ever arrives. A failed run emits `code_review.failed` at ERROR severity (never a success record), making every failure a single `severity=ERROR` query away. `error.message` has the run's own secret values — the GitLab token and the provider API key — scrubbed out before the record is emitted, in every encoding they might appear under (raw, URL/form-encoded, JSON-escaped, base64).

Log records land in Loki (or whichever OTLP log backend you target) and are correlated back to traces via the root span context (`trace_id`/`span_id`) and to metrics via `code_review.run_id` / `vcs.repository.name`.

#### Loki stream labels

By default these records reach Loki with only `service_name` promoted to a stream label; everything else (`vcs_repository_name`, `code_review_run_id`, …) is structured metadata, which requires a full scan to filter. To scope queries efficiently, promote the high-value fields to stream labels in your collector. In the OpenTelemetry Collector, the `loki` exporter reads hints from resource/log attributes:

```yaml
processors:
  attributes/loki:
    actions:
      - key: loki.attribute.labels
        value: vcs_repository_name, code_review_run_id
        action: insert
```

The equivalent in Grafana Alloy's `otelcol.exporter.loki` / `loki.process` pipeline is a `stage.structured_metadata` or `stage.labels` block listing the same two fields. Keep the promoted set small — `vcs_repository_name` is low-cardinality and safe; `code_review_run_id` is high-cardinality, so promote it only if your retention and stream limits allow, otherwise query it from structured metadata.

#### Grafana Cloud token scopes

For all three signals to reach their respective backends, the service account token used in `OTEL_EXPORTER_OTLP_HEADERS` must carry:

- `Traces Publisher` — writes to Tempo
- `Metrics Publisher` — writes to Mimir
- `Logs Publisher` — writes to Loki

A token missing any of these scopes will get a silent `401 Unauthorized: invalid scope requested` from the OTLP gateway. Set `OTEL_LOG_LEVEL=error` to surface export failures.

#### Disabling the bridge

When `CODE_REVIEW_OTEL` is not set, the bridge is a no-op and `@opentelemetry/*` is never imported (dynamic-loaded behind the env check, so unsetting the flag pays no startup cost).

#### Library injection

Library callers with pre-existing `TracerProvider`/`MeterProvider`/`LoggerProvider` can share them by injecting a runtime instead of letting the bridge boot its own `NodeSDK`:

```js
import { metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { startOtelBridge } from '@weareikko/code-review';

await startOtelBridge({
  runtime: {
    tracerProvider: trace.getTracerProvider(),
    meterProvider: metrics.getMeterProvider(),
    loggerProvider: logs.getLoggerProvider(),
    shutdown: async () => {},
  },
});
```
