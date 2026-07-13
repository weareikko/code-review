# Observability

← Back to the [README](../README.md)

## Diagnostics channels

`gitlab-review` publishes opt-in Node.js `diagnostics_channel` tracing events with no external telemetry dependency. Subscribers can listen before calling `run()` or from a Node preload/import hook before running the CLI.

Base tracing channel names:

- `@ikko-dev/gitlab-review:run`
- `@ikko-dev/gitlab-review:scm.get_merge_request`
- `@ikko-dev/gitlab-review:scm.get_latest_version`
- `@ikko-dev/gitlab-review:git.prepare_history`
- `@ikko-dev/gitlab-review:git.get_merge_diff`
- `@ikko-dev/gitlab-review:reviewer.run`
- `@ikko-dev/gitlab-review:review.parse`
- `@ikko-dev/gitlab-review:scm.get_discussions`
- `@ikko-dev/gitlab-review:comments.build`
- `@ikko-dev/gitlab-review:artifact.write_output`
- `@ikko-dev/gitlab-review:scm.post_comments`
- `@ikko-dev/gitlab-review:scm.upsert_summary`

Node emits tracing subchannels as `tracing:<base>:start`, `:end`, `:asyncStart`, `:asyncEnd`, and `:error`. Payloads include safe run metadata (`runId`, phase, project, MR, GitLab URL, model, severity, timings, comment counts, and sanitized `errorInfo`) and intentionally exclude tokens/API keys.

When `--posting-mode draft` is used, the `scm.post_comments` payload also exposes `draftsAbandoned`, `draftsCreated`, `draftsDeletedPrePublish`, and `draftsPublished` counters describing the draft lifecycle within the run.

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
- `gitlab-review.<phase>` — one span per remaining phase (`scm.get_merge_request`, `git.get_merge_diff`, `scm.post_comments`, …) for latency and error rates.

Source-control API read spans (`scm.get_merge_request`, `scm.get_latest_version`, `scm.get_discussions`) carry stable OTel HTTP semantic-convention attributes — `http.request.method`, `http.response.status_code`, `url.full`, `http.response.body.size`, `server.address` — so API rate limits and 4xx/5xx responses are visible at the span level (the failing request's status is recorded even when the call throws). The `git.get_merge_diff` span carries `diff.files_changed`, `diff.lines_added`, and `diff.lines_removed` so duration and cost can be correlated with change size. The root `invoke_workflow` span carries `gitlab_review.run_id` (and `gen_ai.conversation.id`) so a trace can be joined to its metric series and log stream.

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
