# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add GitHub Actions workflows to run CI checks and publish tagged releases to npm ([4b5920b]).
- Add package exports for the CLI entry point and public API type declarations ([5c53a43]).
- Add config validation and argument parsing test coverage ([a167ab1]).

### Changed

- Document the `--cwd` flag and simplify the README GitLab CI example ([0bdf985]).

### Fixed

- Return an honest intermediate min-severity type before runtime validation ([5c53a43]).

## [0.1.0] - 2026.05.18

### Added

- Initial release of `@ikko-dev/gitlab-review`.

[Unreleased]: https://github.com/ikko-dev/gitlab-review/compare/0.1.0...HEAD
[0.1.0]: https://github.com/ikko-dev/gitlab-review/releases/tag/0.1.0
[4b5920b]: https://github.com/ikko-dev/gitlab-review/commit/4b5920b
[5c53a43]: https://github.com/ikko-dev/gitlab-review/commit/5c53a43
[a167ab1]: https://github.com/ikko-dev/gitlab-review/commit/a167ab1
[0bdf985]: https://github.com/ikko-dev/gitlab-review/commit/0bdf985
