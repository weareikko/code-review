# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Reviewer output uses Conventional Comments format**: `buildJSONSystemPrompt` now pins inline comment bodies to the [Conventional Comments](https://conventionalcomments.org/) shape (`<label> [decoration]: <subject>` followed by discussion), and the summary follows a fixed skeleton (`### Overview`, `### Findings`, `### Notes`). Severity ↔ label mapping is enforced: `CRITICAL → "issue (blocking):"`, `WARN → "issue:"`, `INFO → nitpick / suggestion (non-blocking) / note / question / thought`. Severity emoji (🔴/🟡/🔵) is dropped from the prompt to remove visual noise — the structured `severity` JSON field remains the source of truth. The summary's Findings section restates only the subject of each inline comment; it must not duplicate the discussion or fix.
- **Stricter prompt rules**: declarative-tone rule (no hedging in `issue`/`suggestion` subjects) and explicit anti-duplication rule between summary and inline comments. A worked example is included in the prompt to anchor the output shape.

### Added

- **Prior developer replies as review context**: when the MR already has bot-posted review threads with developer replies, those threads are extracted and passed to the reviewer as a `<prior_review_feedback>` section in the prompt. The reviewer can use this to avoid re-raising already-acknowledged concerns and to provide informed follow-up. Threads are filtered to files in the current diff; resolved threads are included but marked as resolved.
- **Commit log as review context**: commit messages for all non-merge commits in the MR are passed to the reviewer as a `<commits>` section prepended to the prompt, giving the reviewer intent context alongside the code diff.
- **Commit message justifications in code-review skill**: the built-in `code-review` skill now instructs the reviewer to treat explicit commit artefacts (ADR numbers, incident references, named sign-offs) as authoritative evidence when justifying otherwise-suspicious patterns.
- **Format-conformance eval scenarios**: `tests/evals/review.eval.ts` adds `ConventionalCommentFormatJudge`, `SummarySkeletonJudge`, and `NoDuplicationJudge` to verify reviewer output conforms to the new format.

## [0.3.12] - 2026-05-26

### Added

- **Warn on invalid auto-discovered skills**: `loadAutoDiscoveredSkills` now accepts an optional `warn` callback. When a `SKILL.md` file is found during auto-discovery but is missing required frontmatter fields (`name` or `description`), the callback is invoked with a message identifying the skill directory. In `runReview`, this is wired to `logger.warn`, so malformed project skills produce a visible warning in CLI output instead of silently being dropped.

## [0.3.11] - 2026-05-26

### Added

- **Commit footer on inline comments**: each inline review comment now ends with a `<sub>` footer — `Reviewed by [@ikko-dev/gitlab-review](…) for commit <sha>.` — identical in format to the summary-note footer. This lets developers see at a glance whether a comment was posted during the current review pass or an earlier one. The footer is appended to the payload body only; fingerprints continue to be computed from the original reviewer output so deduplication is unaffected by the SHA changing between runs.

## [0.3.10] - 2026-05-25

### Changed

- **Lazy skill body loading** ([#42](https://github.com/ikko-dev/gitlab-review/issues/42)): `buildSkillSection` now emits a `<skill_file>` path reference in the system prompt instead of embedding the full `SKILL.md` body inline. The agent reads each skill file on demand using its existing `Read` tool. This prevents system prompt bloat when many or large skills are loaded.
  - `Skill.filePath` (new field): absolute path to the `SKILL.md` file, used in `<skill_file>` references in prompts.
  - `Skill.body` remains populated for backwards compatibility, but prompt construction no longer uses it.
  - The `<skills>` prompt block now opens with a preamble instructing the agent to read each skill file before applying it.

### Added

- **`npm:` and `file:` skill spec protocols** ([#38](https://github.com/ikko-dev/gitlab-review/issues/38)): the `--skill` flag and `GITLAB_REVIEW_SKILLS` env var now accept protocol-prefixed specs alongside existing bare builtin names:
  - `npm:my-skill` — resolves from `node_modules/my-skill` (walked up from `cwd`, supports monorepo hoisting)
  - `npm:@scope/pkg` — scoped npm packages
  - `npm:@scope/bundle/subpath` — named sub-directory within a multi-skill npm bundle
  - `file:./relative/path` — local skill directory relative to `cwd`
  - `file:/absolute/path` — absolute filesystem path
  - Bare names (e.g. `code-review`) continue to resolve from the package-bundled `skills/` directory unchanged.
  - Unresolvable specs now throw a `ConfigError` with an actionable hint instead of being silently skipped.
  - `git:` / `git+ssh:` are parsed but not yet executed (reserved for Phase 2).
- **`parseSkillSpec(spec)` export**: parses a skill spec string into a typed `SkillSpec` discriminated union (`builtin | npm | file | git`). Useful for library callers building custom skill-loading pipelines.
- **`resolveNpmSkillDir(packageName, subpath, cwd)` export**: walks `node_modules` upward from `cwd` and returns the resolved package (or sub-directory) path, or `null` if not found.
- **`loadNamedSkill(spec, cwd)` export**: loads a `Skill` from any supported spec; throws `ConfigError` if the spec cannot be resolved.
- **`Skill['source']`** extended with `'npm' | 'file'` values (in addition to the existing `'builtin' | 'project'`), surfaced in diagnostics and OTel `skills` attribute.

- **Multi-provider LLM support** ([#36](https://github.com/ikko-dev/gitlab-review/issues/36)): `--model` now accepts any provider registered in `@earendil-works/pi-ai` (OpenRouter, Google Gemini, Groq, Mistral, Amazon Bedrock, Google Vertex, and more). The `provider/modelId` format now splits on the first `/` only, so multi-segment IDs like `openrouter/anthropic/claude-3-opus-20240229` and `openrouter/ai21/jamba-large-1.7` are handled correctly.
- **Built-in Ollama support**: `--model ollama/<model>` runs a local Ollama server via the OpenAI-compatible API. No API key is required. Point `OLLAMA_HOST` at the server (default: `http://localhost:11434`).
- **Provider-specific API key auto-resolution**: when `--api-key` / `GITLAB_REVIEW_API_KEY` are not set, the CLI resolves the key from the provider-specific environment variable via `@earendil-works/pi-ai` (e.g. `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`). Providers with ambient credentials (Amazon Bedrock, Google Vertex) are also detected automatically.
- **`--api-key` is no longer required for Ollama models**: `validateConfig` skips the `api-key` check when the provider is `ollama`.
- **`--base-url <url>` / `GITLAB_REVIEW_BASE_URL`**: override the provider API base URL for any OpenAI-compatible endpoint (e.g. a corporate AI gateway or self-hosted vLLM instance).
- **`--max-tokens <n>` / `GITLAB_REVIEW_MAX_TOKENS`**: override the maximum output tokens requested from the model. Applied to all providers — Ollama defaults to 4 096 when not set; registered providers keep their own default when the value is `0`.
- **`OLLAMA_HOST`**: auto-resolved for `ollama/*` models; sets the base URL to `$OLLAMA_HOST/v1` (default: `http://localhost:11434/v1`).
- **Ambient-credentials error hint**: when `--api-key` is missing for `amazon-bedrock` or `google-vertex`, the error message now includes setup instructions (IAM env vars / `gcloud auth application-default login`) instead of the generic "Provide CLI flags" hint.
- **`parseModelProvider` export** from `src/config.ts`: extracts the provider prefix from a `provider/modelId` string. Useful for library callers building custom model logic.

## [0.3.9] - 2026-05-22

### Added

- **`GITLAB_REVIEW_OTEL_CAPTURE_CONTENT=1` opt-in for content capture** (`GITLAB_REVIEW_OTEL=1`): when set, per-turn assistant output text is attached to `gen_ai.agent.turn` spans as `gen_ai.output.messages` (Sentry Conversations-compatible JSON format), and tool arguments / results are attached to `execute_tool` spans as `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result`. Content is truncated at 2 000 chars per attribute to stay within typical span size limits. Disabled by default — only enable after confirming your observability backend's data-retention and PII policies allow storing code review content. The `captureContent` field on `OtelBridgeOptions` provides the programmatic equivalent for library callers.
- **`isContentCaptureEnabled()` export** from `src/otel.ts`: reflects the `GITLAB_REVIEW_OTEL_CAPTURE_CONTENT` opt-in check, mirroring the pattern of `isOtelEnabled()`.

### Fixed

- **`gen_ai.usage.input_tokens` now reports total input** (non-cached + cached) on `gen_ai.agent.turn` spans and the `invoke_agent gitlab-review` phase span, matching the Sentry AI monitoring convention. Previously it reported only non-cached input tokens, which caused Sentry's cost calculator to produce negative cache costs. `gen_ai.usage.input_tokens.cached` is now also set as the SUBSET attribute when cache reads are non-zero. `gen_ai.usage.cache_read.input_tokens` is kept unchanged for Grafana/Tempo backward compatibility.
- Same `gen_ai.usage.input_tokens` total fix applied to the `gitlab_review.completed` OTel log record, which now also carries `gen_ai.usage.input_tokens.cached`.

## [0.3.8] - 2026-05-21

### Fixed

- **OTel `gen_ai.client.cost` double-count** (`GITLAB_REVIEW_OTEL=1`): cost was previously emitted from two places — `recordGenAiMetrics` at `reviewer.run` phase close (with `gen_ai.system`) and `buildAgentSubscriber` at `message_end` (without `gen_ai.system` when the Anthropic SDK returns a bare model ID). This created two Prometheus series per review run that differed only by presence/absence of `gen_ai_system`, causing a naive `sum()` in Grafana to return 2× the real cost. `gen_ai.client.cost` is now emitted exclusively per-turn by `buildAgentSubscriber`.
- **OTel cache token metrics absent** (`GITLAB_REVIEW_OTEL=1`): `gen_ai_client_token_usage_sum` was missing `cache_read` and `cache_creation` series entirely, even though these tokens dominate cache-heavy workloads (cache write alone can be ~86% of cost). `buildAgentSubscriber` now emits `gen_ai.token.type=cache_read` and `gen_ai.token.type=cache_creation` for each turn alongside the existing `input` and `output` observations, completing the four-type picture required by the OTel GenAI semantic conventions.
- **`gen_ai.system` missing from per-turn metrics** when the Anthropic SDK emits bare model IDs (e.g. `claude-sonnet-4-5` without the `anthropic/` prefix): `buildAgentSubscriber` now receives the configured model string (e.g. `anthropic/claude-sonnet-4-5`) from `RunMeta` via `createAgentTelemetry` and falls back to it when `msg.model` has no slash. All four token type metrics and the cost metric now carry a consistent, complete label set including `gen_ai.system`.
- **`gen_ai.client.token.usage` potential double-count** from the same root cause as cost: token metrics are now also emitted exclusively by `buildAgentSubscriber` to avoid a parallel two-series problem. `gen_ai.client.operation.duration` remains the sole metric emitted by `recordGenAiMetrics` (aggregate reviewer-phase duration is not per-turn).
- **Model string split bug** in `applyGenAiAttributes` and `recordGenAiMetrics`: the previous `model.split('/')[0]` pattern incorrectly set `gen_ai.system` to the full model string (e.g. `claude-sonnet-4-5`) when no slash was present. All three parse sites now use `indexOf('/')` so they produce `undefined` (attribute omitted) rather than a garbage provider value when the model ID contains no prefix.
- **Log records not correlated to traces**: `logger.emit()` calls for `gitlab_review.completed` and `gitlab_review.comment` events did not carry a span context, so the OTel logger SDK could not stamp `traceId`/`spanId` on those log records. The root span's context is now captured when the `invoke_workflow gitlab-review` span opens and passed as the `context:` field to every `logger.emit()` call, enabling backend log-trace linking.
- **`gen_ai.client.cost` not broken down by token type**: cost was previously recorded as a single observation per turn with no `gen_ai.token.type` dimension. It is now split into up to four observations per turn (`input`, `output`, `cache_read`, `cache_creation`), matching the token-usage metric structure and enabling cost attribution by token class.
- **`gen_ai.usage.cost.cache_write_usd` span attribute renamed** to `gen_ai.usage.cost.cache_creation_usd` to match the OTel GenAI semantic convention term `cache_creation` used everywhere else (token type label, token usage attribute names).
- **`gen_ai.response.model` removed from metric data-point labels**: this attribute belongs on spans (traces) only; including it as a metric label doubled cardinality without benefit since the request model is already present via `gen_ai.request.model`. Both `buildAgentSubscriber` and `recordGenAiMetrics` no longer add it to metric attribute sets.
- **Cost histogram unit** corrected from `'usd'` to `'{usd}'` on both `gen_ai.client.cost` and `gitlab_review_total_cost_usd` instruments to conform to the OTel unit annotation syntax for non-SI units.
- **Spurious zero-value `gitlab_review_comments_total` increments**: the counter was unconditionally incremented even when `posted` was 0 (skipped or dry-run runs), polluting Grafana rate queries. The increment is now guarded by `if (posted > 0)`.
- **`CI_JOB_ID` and `CI_PIPELINE_ID` missing from spans and logs**: these high-cardinality CI identifiers are now captured by a new `buildCiSpanAttrs()` helper and attached to all phase spans and log records as `gitlab.ci_job_id` / `gitlab.ci_pipeline_id`. They are intentionally excluded from metric data-point labels to avoid cardinality explosion in Prometheus/Mimir.

## [0.3.7] - 2026-05-21

### Fixed

- **OTel metric data quality** (`GITLAB_REVIEW_OTEL=1`): several label gaps in the metrics and log records emitted by the OTel bridge have been closed.
  - `service.name="@ikko-dev/gitlab-review"` is now included as an explicit data-point attribute on every `gitlab_review_*` and `gen_ai.*` metric observation. The SDK-level `service.name` resource attribute only populates `target_info` in Prometheus/Mimir; without it on each data point these metrics were invisible to provider-scoped queries and Grafana GenAI dashboards.
  - `gen_ai.system` replaces the non-standard `gen_ai.provider.name` attribute on the aggregate `invoke_agent gitlab-review` span and on all `gen_ai.client.*` metric observations emitted by `recordGenAiMetrics`. `gen_ai.system` is the required attribute in the OTel GenAI semantic conventions.
  - `gen_ai.system` is now also set on per-turn `gen_ai.agent.turn` spans and per-turn `gen_ai.client.token.usage`, `gen_ai.client.cost`, and `gen_ai.client.time_to_first_token` metric observations. Previously the provider portion of the model string was extracted but discarded.
  - `gen_ai.agent.name="gitlab-review"` is now set on per-turn `gen_ai.agent.turn` spans (it was already set on the parent `invoke_agent` span).
  - `gitlab_review.warnings`, `gitlab_review.drafts.abandoned`, and `gitlab_review.drafts.deleted_pre_publish` span attributes are now emitted from `applyResultAttributes`. These three `DiagnosticContext` fields were populated by the posting phases but never written to OTel spans.
  - `service.name="@ikko-dev/gitlab-review"` is now included as an explicit attribute on `gitlab_review.comment` and `gitlab_review.completed` log records for consistent label presence alongside metrics.

## [0.3.6] - 2026-05-21

### Added

- **`gen_ai.conversation.id` OTel attribute**: every span emitted by the OTel bridge (all phase spans and per-turn `gen_ai.agent.turn` spans) now carries `gen_ai.conversation.id` set to the run UUID. This follows the OpenTelemetry GenAI semantic conventions and unlocks the Sentry Conversations view as well as cross-span querying by conversation in any OTel-compatible backend.
- **Run ID footnote in MR summary notes**: when `postSummary` is enabled, the posted summary note now includes a `<sub>Run ID: \`<uuid>\`</sub>` footnote so the trace can be located in Sentry (or any OTel backend) directly from the MR.

## [0.3.5] - 2026-05-21

### Added

- **Review-level OTel metrics** (`GITLAB_REVIEW_OTEL=1`): five new Prometheus-compatible instruments emitted once per complete run (success, error, or timeout) at the close of the `invoke_workflow gitlab-review` root span ([#37]).
  - `gitlab_review_run_duration_seconds` (Histogram, boundaries 5–600 s) — overall run duration, labelled with `gitlab.project_path`, `gitlab.pipeline_source`, `gitlab_review.dry_run`, and `gitlab_review.status`.
  - `gitlab_review_total_cost_usd` (Histogram, boundaries 0.001–1.0 USD) — total LLM spend for the run, summed across all turns.
  - `gitlab_review_comments_total` (Counter) — number of MR comments posted.
  - `gitlab_review_drafts_published_total` (Counter) — number of draft notes bulk-published.
  - `gitlab_review_phase_duration_seconds` (Histogram, boundaries 1–300 s) — per-phase latency with a `gitlab_review.phase` label, covering every diagnostic phase including the root run.
  - `gitlab_review.status` is `success`, `error`, or `timeout`; `AbortError`/`ETIMEDOUT` are classified as `timeout` so Grafana alerts can treat deadline-exceeded runs separately from hard failures.
  - `gitlab.mr_iid` is intentionally excluded from all metric labels (high cardinality); it remains available on spans only.
  - The existing `gen_ai.client.*` per-turn metrics are unchanged.

## [0.3.4] - 2026-05-21

### Added

- **GitLab CI project attributes on OTel metrics, spans, and logs**: when running inside a GitLab CI pipeline, four CI environment variables are now automatically included as attributes on every metric data point, span, and log record emitted by the OTel bridge. `gitlab.project_path` (`CI_PROJECT_PATH`, e.g. `group/my-project`), `gitlab.project_namespace` (`CI_PROJECT_NAMESPACE`), `gitlab.mr_target_branch` (`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`), and `gitlab.pipeline_source` (`CI_PIPELINE_SOURCE`) are captured once at bridge startup and spread into all emission sites — run-level histograms, per-turn metrics, phase spans, comment logs, and the `gitlab_review.completed` log record. Attributes are omitted gracefully when the vars are not set (local runs). Enables Prometheus/Mimir queries like `sum by (gitlab_project_path) (increase(gen_ai_client_cost_sum[7d]))` to compare token spend and cost across projects.

## [0.3.3] - 2026-05-21

### Added

- **Richer OTel agent telemetry** (`GITLAB_REVIEW_OTEL=1`): per-turn `gen_ai.agent.turn` spans and per-call `execute_tool <name>` grandchild spans now appear under `invoke_agent gitlab-review` in Tempo, giving a full tool-use timeline. Per-turn `gen_ai.client.token.usage`, `gen_ai.client.cost`, and `gen_ai.client.time_to_first_token` metrics break down spend and latency by turn ([#35]).
- **OTel structured log records**: one `gitlab_review.comment` log record per generated comment (file, line, severity, duplicate flag, body) and one `gitlab_review.completed` record per run (cost, tokens, model, comment counts) sent to Loki/the configured log backend. Requires the `Logs Publisher` scope on the Grafana Cloud access policy token alongside `Traces Publisher` and `Metrics Publisher` ([#35]).

## [0.3.2] - 2026-05-20

### Added

- **Structured logger**: a `Logger` interface (`debug`/`info`/`warn`/`error` levels) with a `createLogger(minLevel)` factory and a `noopLogger` no-op for library consumers. All log output goes to stderr (169c470, #33).
- **`--verbose` flag** (or `GITLAB_REVIEW_VERBOSE=true` env var): enables `debug`-level logging. Without it, only `info`-level phase lines are printed. Debug output includes loaded skills and convention files, agent turn numbers, and individual tool calls with argument previews (e.g. `→ Read src/auth.ts`, `→ Bash grep -n …`) (169c470, #33).

## [0.3.1] - 2026-05-20

### Fixed

- Draft mode: remap `body` → `note` when posting inline comments to the draft notes API. The discussions endpoint uses `body` for comment text; the draft notes endpoint uses `note`. The same payload was passed unchanged to both, causing every draft inline comment to be rejected with 400 "note is missing" ([#32]).

## [0.3.0] - 2026-05-19

### Added

- **Skills**: domain-specific review modules that sharpen the agent's focus. Load built-in skills with `--skill <name>` (repeatable) or `GITLAB_REVIEW_SKILLS` (comma-separated). Project skills are auto-discovered from `.agents/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md`, walking from the git root to `cwd`; a skill closer to `cwd` overrides one of the same name higher up; project skills override built-ins. Each skill injects a focused instruction block and optional `references/` files into the system prompt — reference files are made available by path so the agent can read them on demand ([#31]).
- **Built-in `code-review` skill**: adversarial correctness reviewer that reports only real, demonstrable bugs with a concrete proof path (specific input → failure → observable symptom). Includes per-language reference files for JavaScript/TypeScript and PHP/Laravel covering async/promise pitfalls, type coercion traps, React hook gotchas, Eloquent N+1, non-atomic Laravel writes, and more ([#31]).
- Active skill names appear in the MR summary note footer (`Skills: \`code-review\``) after the cost line, and in `review-usage.json`under`skills` ([#31]).
- `runReview` now accepts a `timeoutMs` option (default 10 min); the agent run is raced against a `ReviewerError` timeout promise so hung LLM calls do not block the CI job indefinitely.
- New `dist/review.js` Vite build entry exposes the public library API (`runReview`, context helpers, etc.) separately from the CLI bundle; the `"."` package export now points to `review.js` / `review.d.ts` instead of the CLI entry.
- `typecheck:tests` script (`tsgo -p tsconfig.test.json --noEmit`) and matching `tsconfig.test.json` extend type-checking to the `tests/` directory, catching incomplete `Config` objects and other test-fixture type errors.

### Changed

- Switch license from MIT to FSL-1.1-ALv2 (Functional Source License). Internal use, education, research, and professional services remain freely permitted; the restriction covers commercial products or services that compete with gitlab-review. The license converts to Apache 2.0 two years after each release.
- The summary comment now always opens with a `## Code Review` level-2 heading, making the bot's note easy to identify in busy MR discussions ([#28]).
- `--skill` flag is now handled natively by `parseArgs` as a multi-value flag (`MULTI_FLAGS`), replacing the separate `parseSkills` pass over `argv`; both `--skill foo --skill bar` and `--skill=foo` forms are supported and accumulate correctly.
- `UpsertSummaryOptions` no longer re-declares `skillsFooter`; it now inherits the field cleanly from `SummaryBodyOptions`.

### Fixed

- Inject today's date into the reviewer system prompt and add a rule banning claims about external state (dates, library versions, deprecation status, API availability) that cannot be verified from the diff, preventing a class of hallucinations where the reviewer flags correct information as wrong based on stale world knowledge ([#29]).
- `GitLabClient.request()` no longer unconditionally sets `Content-Type: application/json`; the header is now only added when `init.body` is present, avoiding a spurious content-type on GET and DELETE requests.
- `GitLabClient.paginate()` now wraps each page fetch in an `AbortController` timeout (same `requestTimeout` used by `request()`), so long-running paginated calls are bounded by the same timeout as single requests.
- Eval helper function renamed from `hasApiKey` to `missingApiKey` to match its actual semantics (returns `true` when the key is absent).

## [0.2.0] - 2026-05-19

### Added

- Skip reviewer execution when the current MR head commit already appears in the summary note's reviewed-commit footer, avoiding duplicate reviews for the same diff. Add the reviewed-commit footer to summary notes, link it to the `gitlab-review` GitHub repository, and provide a `--force-review` / `GITLAB_REVIEW_FORCE_REVIEW` override for intentional re-runs ([#25], [#26]).

### Changed

- Align project naming to `gitlab-review` across code, docs, tests, generated markers, OpenTelemetry agent/span naming, the default review artifact (`gitlab-review.md`), and project-specific `GITLAB_REVIEW_*` environment variables. Existing legacy hidden MR markers remain readable to avoid duplicate comments and summaries during migration ([#27]).

## [0.1.11] - 2026-05-19

### Changed

- Preserve previous MR-level summary runs in a collapsed `Previous review runs` history section when updating the summary note, instead of erasing them; the latest summary remains at the top and history retention is bounded to 10 previous runs ([#24]).

## [0.1.10] - 2026-05-19

### Added

- The MR-level summary note now includes a cost footer (token counts and USD total, the same line printed to the CI log) appended after a horizontal rule, so reviewers can see the run cost directly on the MR ([#22]).

### Changed

- The summary note is now upserted **before** inline comments are posted, so it appears at the top of the MR activity feed rather than after the inline threads ([#22]).

## [0.1.9] - 2026-05-19

### Added

- Post the reviewer's overall `summary` as a non-positional merge request note — the same shape a human reviewer creates from the MR comment box. The note carries a hidden `<!-- gitlab-review:summary -->` marker so subsequent runs find the existing note and update it in place via `PUT /merge_requests/:iid/notes/:id` instead of piling up duplicates. Default-on; disable with `--no-summary` or `GITLAB_REVIEW_POST_SUMMARY=false`. Skipped under `--dry-run` / `--no-post`. Runs in both `direct` and `draft` posting modes (always via the regular notes endpoints) ([#19]).
- New `GitLabClient` methods: `createMergeRequestNote`, `updateMergeRequestNote` ([#19]).
- New `gitlab.upsert_summary` diagnostics channel and OTel attributes (`gitlab_review.summary.action`, `gitlab_review.summary.note_id`) exposing whether the summary note was created or updated and its resolved id ([#19]).
- Emit OpenTelemetry GenAI client metrics (`gen_ai.client.operation.duration`, `gen_ai.client.token.usage`) alongside spans so Grafana Application Observability / AI Observability surfaces — and any OTel-compliant LLM observability consumer driven off these metric names — discover the service from its metrics without dashboard import.

### Changed

- **Breaking (library callers only).** Dropped the structural OTel typing shim and adopted the canonical `@opentelemetry/api` provider-injection pattern. Callers passing a `runtime:` to `startOtelBridge` now provide `tracerProvider` + `meterProvider` instead of the full `api` namespace. The opt-in CLI flag (`GITLAB_REVIEW_OTEL=1`) and the bundled-runtime path are unchanged — only the library-DI shape moved. See the README snippet for the new form.

### Fixed

- OTel `service.version` resource attribute is now inlined at build time from `package.json` via Vite's `define`, so it reads the real package version under `npx` / standalone bin invocations instead of falling back to `'0.0.0'` (the previous `process.env.npm_package_version` lookup was only populated by `npm run`).

## [0.1.8] - 2026-05-19

### Fixed

- OpenTelemetry bridge boot crash with `resources.Resource is not a constructor`. The bootstrap now uses the `@opentelemetry/resources` v2 factory API (`resourceFromAttributes` merged onto `defaultResource()`) instead of the removed v1 `new Resource(...)` constructor, so opt-in runs (`GITLAB_REVIEW_OTEL=1`) start cleanly again ([#18]).

## [0.1.7] - 2026-05-19

### Added

- Opt-in OpenTelemetry bridge: set `GITLAB_REVIEW_OTEL=1` to emit spans tagged with the OpenTelemetry GenAI semantic conventions (`gen_ai.*`), including per-run token usage and USD cost on the `invoke_agent gitlab-review` span. Exporter selection follows the standard `OTEL_*` env vars, so the same run reports into Tempo, Datadog, Honeycomb, SigNoz, or Grafana Cloud AI Observability (Sigil) ([#17]).

## [0.1.6] - 2026-05-19

### Fixed

- Parse JSON review fences whose comment bodies contain nested fenced code blocks by only treating backticks at the beginning of a line as the closing fence ([#15]).

### Changed

- Use Codecov OIDC authentication for coverage and test-result uploads in CI ([#15]).

## [0.1.5] - 2026-05-19

### Added

- `--posting-mode draft` (env: `GITLAB_REVIEW_POSTING_MODE`) creates GitLab draft notes for every fresh comment and publishes them atomically via `POST /draft_notes/bulk_publish` so the MR never shows a half-posted review. Hardened with orphan cleanup at run start, bounded-concurrency (cap 10) draft creation, a pre-publish fingerprint re-check that drops drafts colliding with discussions posted between dedupe and publish, and same-run self-heal that sweeps partial drafts if a creation fails mid-flight. Default stays `direct` for one release ([#14]).
- New `GitLabClient` methods: `getCurrentUser`, `listDraftNotes`, `createDraftNote`, `deleteDraftNote`, `bulkPublishDraftNotes` ([#14]).
- `gitlab.post_comments` diagnostic payload now exposes `draftsAbandoned`, `draftsCreated`, `draftsDeletedPrePublish`, and `draftsPublished` when draft mode is used ([#14]).

### Changed

- Post-run log reports drafts dropped by the pre-publish re-check separately from duplicates instead of conflating them in the `(N duplicates skipped)` count ([#14]).

## [0.1.4] - 2026-05-18

### Added

- Make the review agent's `thinkingLevel` configurable. New `--thinking <level>` flag and `GITLAB_REVIEW_THINKING_LEVEL` env var accept `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` (default: `off`). Thinking tokens are billed at the model output rate and are reflected in the `Review usage:` line and `review-usage.json` ([#13]).

## [0.1.3] - 2026-05-18

### Fixed

- `formatUsageLine` now reports billable input as `input + cacheRead + cacheWrite` instead of the uncached delta alone, so the `Review usage:` line agrees with the cost figure when Anthropic prompt caching is active. Adds a `(N cached)` hint when `cacheRead > 0` ([#12]).

## [0.1.2] - 2026-05-18

### Added

- Own the review pipeline: drive `@earendil-works/pi-agent-core` directly so token usage and cost are captured per run. Surface a `Review usage: ... in / ... out tokens — $... (model)` line at the end of the CLI run and write a sibling `review-usage.json` artifact with input/output/cacheRead/cacheWrite token and cost breakdowns ([#11]).

### Changed

- Replace the bundled `gitlab-review` dependency with direct pinned dependencies on `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent`. Conventions loading (`AGENTS.md` / `CLAUDE.md` / `REVIEW.md`), prompt building, and diff noise filtering now live in this package ([#11]).

## [0.1.1] - 2026-05-18

### Fixed

- Forward shell-quoted Git diff arguments to `gitlab-review` instead of raw diff content.

## [0.1.0] - 2026-05-18

### Added

- Initial release of `@ikko-dev/gitlab-review` ([a6166f5], [310dccf]).
- Add package metadata and expanded README usage documentation ([c2a11c0]).
- Add package exports for the CLI entry point and public API type declarations ([5c53a43]).
- Add config validation and argument parsing test coverage ([a167ab1]).
- Add GitHub Actions workflows to run CI checks and publish tagged releases to npm ([4b5920b]).
- Add opt-in `diagnostics_channel` tracing events for the run lifecycle and review phases ([1a610da]).
- Add Vitest coverage reporting and Codecov upload integration ([1a610da]).

### Changed

- Update build and lint tooling ([38190f7]).
- Stop tracking built `dist` files and ignore generated build artifacts ([fa64a59], [64c9d09]).
- Document the `--cwd` flag and simplify the README GitLab CI example ([0bdf985]).
- Update GitHub Actions to Node 24-compatible action versions ([2c4971b]).

### Fixed

- Rename the npm package scope to `@ikko-dev/gitlab-review` ([c29faef]).
- Add typed runtime errors for clearer CLI failures ([cd4220d]).
- Return an honest intermediate min-severity type before runtime validation ([5c53a43]).

[Unreleased]: https://github.com/ikko-dev/gitlab-review/compare/0.3.10...HEAD
[0.3.10]: https://github.com/ikko-dev/gitlab-review/compare/0.3.9...0.3.10
[0.3.9]: https://github.com/ikko-dev/gitlab-review/compare/0.3.8...0.3.9
[0.3.8]: https://github.com/ikko-dev/gitlab-review/compare/0.3.7...0.3.8
[0.3.7]: https://github.com/ikko-dev/gitlab-review/compare/0.3.6...0.3.7
[0.3.6]: https://github.com/ikko-dev/gitlab-review/compare/0.3.5...0.3.6
[0.3.5]: https://github.com/ikko-dev/gitlab-review/compare/0.3.4...0.3.5
[0.3.4]: https://github.com/ikko-dev/gitlab-review/compare/0.3.3...0.3.4
[0.3.3]: https://github.com/ikko-dev/gitlab-review/compare/0.3.2...0.3.3
[0.3.2]: https://github.com/ikko-dev/gitlab-review/compare/0.3.1...0.3.2
[0.3.1]: https://github.com/ikko-dev/gitlab-review/compare/0.3.0...0.3.1
[0.3.0]: https://github.com/ikko-dev/gitlab-review/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.2.0
[0.1.11]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.11
[0.1.10]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.10
[0.1.9]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.9
[0.1.8]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.8
[0.1.7]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.7
[0.1.6]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.6
[0.1.5]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.5
[0.1.4]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.4
[0.1.3]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.3
[0.1.2]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.2
[0.1.1]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.1
[#11]: https://github.com/ikko-dev/gitlab-review/pull/11
[#12]: https://github.com/ikko-dev/gitlab-review/pull/12
[#13]: https://github.com/ikko-dev/gitlab-review/pull/13
[#14]: https://github.com/ikko-dev/gitlab-review/pull/14
[#15]: https://github.com/ikko-dev/gitlab-review/pull/15
[#17]: https://github.com/ikko-dev/gitlab-review/pull/17
[#18]: https://github.com/ikko-dev/gitlab-review/pull/18
[#19]: https://github.com/ikko-dev/gitlab-review/pull/19
[#22]: https://github.com/ikko-dev/gitlab-review/pull/22
[#24]: https://github.com/ikko-dev/gitlab-review/pull/24
[#25]: https://github.com/ikko-dev/gitlab-review/pull/25
[#26]: https://github.com/ikko-dev/gitlab-review/pull/26
[#27]: https://github.com/ikko-dev/gitlab-review/pull/27
[#28]: https://github.com/ikko-dev/gitlab-review/pull/28
[#29]: https://github.com/ikko-dev/gitlab-review/pull/29
[#31]: https://github.com/ikko-dev/gitlab-review/pull/31
[#32]: https://github.com/ikko-dev/gitlab-review/pull/32
[#35]: https://github.com/ikko-dev/gitlab-review/pull/35
[0.1.0]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.0
[a6166f5]: https://github.com/ikko-dev/gitlab-review/commit/a6166f5
[310dccf]: https://github.com/ikko-dev/gitlab-review/commit/310dccf
[c2a11c0]: https://github.com/ikko-dev/gitlab-review/commit/c2a11c0
[38190f7]: https://github.com/ikko-dev/gitlab-review/commit/38190f7
[fa64a59]: https://github.com/ikko-dev/gitlab-review/commit/fa64a59
[64c9d09]: https://github.com/ikko-dev/gitlab-review/commit/64c9d09
[cd4220d]: https://github.com/ikko-dev/gitlab-review/commit/cd4220d
[c29faef]: https://github.com/ikko-dev/gitlab-review/commit/c29faef
[5c53a43]: https://github.com/ikko-dev/gitlab-review/commit/5c53a43
[0bdf985]: https://github.com/ikko-dev/gitlab-review/commit/0bdf985
[a167ab1]: https://github.com/ikko-dev/gitlab-review/commit/a167ab1
[4b5920b]: https://github.com/ikko-dev/gitlab-review/commit/4b5920b
[1a610da]: https://github.com/ikko-dev/gitlab-review/commit/1a610da
[2c4971b]: https://github.com/ikko-dev/gitlab-review/commit/2c4971b
