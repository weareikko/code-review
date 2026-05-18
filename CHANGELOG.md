# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ikko-dev/gitlab-review/compare/0.1.1...HEAD
[0.1.1]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.1
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
