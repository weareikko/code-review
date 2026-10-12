# CLAUDE.md

## Project

`@weareikko/code-review` is a Node.js `>=24`, ESM TypeScript CLI/library. It runs an agent-driven GitLab MR review, parses structured reviewer output, deduplicates inline comments with hidden fingerprints, posts/upserts MR notes, and optionally emits diagnostics/OpenTelemetry data.

## Commands

- Install: `npm ci`
- Lint: `npm run lint`
- Format: `npm run format` / `npm run format:check`
- Typecheck: `npm run typecheck && npm run typecheck:tests`
- Unit tests: `npm test`
- Coverage: `npm run test:ci`
- Build: `npm run build`
- Full local check: `npm run check`
- Evals: `npm run test:evals` (requires `ANTHROPIC_API_KEY` or `CODE_REVIEW_API_KEY`; calls real LLMs)

## Architecture map

- `src/cli.ts`: CLI entry, `run()` orchestration, artifacts, summary posting, diagnostics phases.
- `src/config.ts`: argv/env resolution and validation.
- `src/git.ts`: Git history prep and merge diff generation.
- `src/gitlab.ts`: GitLab API client; keep token handling and request shapes explicit.
- `src/gitlab-review.ts`: reviewer agent setup, prompt construction, context/skill loading, diff filtering, usage aggregation.
- `src/parser.ts`: parses JSON/legacy markdown reviewer output.
- `src/fingerprints.ts`: duplicate-prevention markers and hash logic.
- `src/payloads.ts`: converts parsed comments to GitLab discussion payloads.
- `src/posting.ts`: direct/draft posting, summary note upsert/history, reviewed-commit skip marker.
- `src/diagnostics.ts` and `src/otel.ts`: diagnostics_channel tracing and opt-in OTel bridge.
- `src/review.ts`: public library exports.
- `skills/code-review/`: built-in skill packaged with the npm artifact.
- `tests/evals/`: LLM-backed evaluation tests and fixtures.

## Coding conventions

- Use strict TypeScript and ESM imports with `.js` suffix for local runtime imports.
- Prefer small exported pure helpers with focused Vitest coverage.
- Keep runtime code Node 24-compatible and avoid CommonJS.
- Preserve oxlint/oxfmt style: 2 spaces, single quotes, semicolons, trailing commas, sorted imports.
- Do not add default exports unless matching existing patterns.
- Keep secrets out of logs, diagnostics, artifacts, and errors.
- Prefer typed project errors from `src/errors.ts` with actionable `hint` values.

## Behavioral rules

- Keep reviewer output parsing backwards-compatible with legacy `pi-reviewer` markers where existing code already supports them.
- Do not change fingerprint marker formats, summary markers, or reviewed-commit footer formats without migration tests.
- Keep `draft` posting atomic: cleanup orphan drafts, create drafts, re-check fingerprints, then bulk publish.
- Summary notes are non-positional MR notes and should be upserted, not duplicated.
- Dry-run/no-post must write artifacts but never post to GitLab.
- Noise filtering should continue to skip lockfiles, generated files, build output, coverage, and declaration files.

## Testing guidance

- Add/update unit tests next to changed source files (`src/*.test.ts`).
- For config/CLI changes, cover CLI flags and env fallbacks.
- For GitLab API changes, mock `fetch` and assert URL, method, headers, and body.
- For posting changes, test duplicate handling, draft cleanup, race deletion, and publish counts.
- For parser/fingerprint changes, test marker stripping and legacy compatibility.
- For reviewer prompt/skill changes, update `src/gitlab-review.test.ts`; only use evals when model behavior matters.

## Release and repository notes

- Commit messages in history use Conventional Commits (`feat:`, `fix:`, `chore:`).
- **Never edit `CHANGELOG.md` directly.** Each PR adds a fragment `.changelog/<slug>.md` (slug = branch name without its prefix, e.g. `feat/review-labels` → `review-labels.md`).
- A fragment only contains `### Added|Changed|Deprecated|Removed|Fixed|Security|Dependencies` headings, each followed by its entries — no `#`/`##` heading. Mark breaking changes with a `**BREAKING**:` prefix under `### Changed`.
- **Do not write the PR number**: the release appends `[[#N]]` and its link definition from the merged PR that added the fragment. Other references (`[abc1234]` commits) need their link definition in the fragment.
- Entries are terse — ideally one line per change. Don't restate rationale, internals, or edge cases that the PR already covers.
- The `Changelog` check fails when a PR changes `src/**`, `bin/**`, `skills/**`, `action.yml` or `.github/workflows/code-review.yml` without a fragment; set the `no-changelog` label for changes users do not see (tests, refactors, tooling). Format: [`weareikko/changelog`](https://github.com/weareikko/changelog).
- Release with the `Publish` workflow: `gh workflow run publish.yml -f bump=patch` (or `minor` / `major`). It tests, bumps `package.json`, folds `.changelog/` into `CHANGELOG.md`, commits `chore: release <version>`, tags, publishes to npm, creates the GitHub release and moves the `0` / `0.x` tags. Do not tag or publish by hand.
- Prereleases: `gh workflow run publish.yml -f bump=prerelease -f preid=beta` (or `prepatch` / `preminor` / `premajor`, `preid` `alpha` / `beta` / `rc`). A version with a `-` goes to the `next` npm dist-tag, is a GitHub prerelease and does not move the `0` / `0.x` tags. The stable release of a prerelease can have no new fragment.
- npm publishing uses trusted publishing (OIDC, no npm token), bound to `publish.yml`: keep the publish job in that file. It skips a version that npm already has, so "Re-run failed jobs" on a failed `Publish to npm` job is safe.
- Release tags are plain semver (`0.3.1`), not `v0.3.1`; the pre-push hook rejects `v*` tags.
- Published package files are limited by `package.json#files`; remember `dist/`, `bin/`, `skills/`, `LICENSE`, and `README.md`.
- Do not edit generated `dist/`, `coverage/`, `node_modules/`, or test result artifacts.
