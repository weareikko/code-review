# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Parse JSON review fences whose comment bodies contain nested fenced code blocks by only treating backticks at the beginning of a line as the closing fence ([#15]).

### Changed

- Use Codecov OIDC authentication for coverage and test-result uploads in CI ([#15]).

## [0.1.5] - 2026-05-19

### Added

- `--posting-mode draft` (env: `PI_REVIEWER_POSTING_MODE`) creates GitLab draft notes for every fresh comment and publishes them atomically via `POST /draft_notes/bulk_publish` so the MR never shows a half-posted review. Hardened with orphan cleanup at run start, bounded-concurrency (cap 10) draft creation, a pre-publish fingerprint re-check that drops drafts colliding with discussions posted between dedupe and publish, and same-run self-heal that sweeps partial drafts if a creation fails mid-flight. Default stays `direct` for one release ([#14]).
- New `GitLabClient` methods: `getCurrentUser`, `listDraftNotes`, `createDraftNote`, `deleteDraftNote`, `bulkPublishDraftNotes` ([#14]).
- `gitlab.post_comments` diagnostic payload now exposes `draftsAbandoned`, `draftsCreated`, `draftsDeletedPrePublish`, and `draftsPublished` when draft mode is used ([#14]).

### Changed

- Post-run log reports drafts dropped by the pre-publish re-check separately from duplicates instead of conflating them in the `(N duplicates skipped)` count ([#14]).

## [0.1.4] - 2026-05-18

### Added

- Make the review agent's `thinkingLevel` configurable. New `--thinking <level>` flag and `PI_REVIEWER_THINKING_LEVEL` env var accept `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` (default: `off`). Thinking tokens are billed at the model output rate and are reflected in the `Review usage:` line and `review-usage.json` ([#13]).

## [0.1.3] - 2026-05-18

### Fixed

- `formatUsageLine` now reports billable input as `input + cacheRead + cacheWrite` instead of the uncached delta alone, so the `Review usage:` line agrees with the cost figure when Anthropic prompt caching is active. Adds a `(N cached)` hint when `cacheRead > 0` ([#12]).

## [0.1.2] - 2026-05-18

### Added

- Own the review pipeline: drive `@earendil-works/pi-agent-core` directly so token usage and cost are captured per run. Surface a `Review usage: ... in / ... out tokens — $... (model)` line at the end of the CLI run and write a sibling `review-usage.json` artifact with input/output/cacheRead/cacheWrite token and cost breakdowns ([#11]).

### Changed

- Replace the bundled `pi-reviewer` dependency with direct pinned dependencies on `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent`. Conventions loading (`AGENTS.md` / `CLAUDE.md` / `REVIEW.md`), prompt building, and diff noise filtering now live in this package ([#11]).

## [0.1.1] - 2026-05-18

### Fixed

- Forward shell-quoted Git diff arguments to `pi-reviewer` instead of raw diff content.

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

[Unreleased]: https://github.com/ikko-dev/gitlab-review/compare/0.1.5...HEAD
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
