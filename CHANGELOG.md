# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Switch license from MIT to FSL-1.1-ALv2 (Functional Source License). Internal use, education, research, and professional services remain freely permitted; the restriction covers commercial products or services that compete with gitlab-review. The license converts to Apache 2.0 two years after each release.

### Fixed

- Inject today's date into the reviewer system prompt and add a rule banning claims about external state (dates, library versions, deprecation status, API availability) that cannot be verified from the diff, preventing a class of hallucinations where the reviewer flags correct information as wrong based on stale world knowledge ([#29]).

### Changed

- The summary comment now always opens with a `## Code Review` level-2 heading, making the bot's note easy to identify in busy MR discussions ([#28]).

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

[Unreleased]: https://github.com/ikko-dev/gitlab-review/compare/0.2.0...HEAD
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
