# CLAUDE.md

## Project

An npm workspaces monorepo (Node.js `>=24`, ESM TypeScript) with two public packages that share one version:

- `packages/code-review` — `@weareikko/code-review`: the CLI/library that runs an agent-driven GitLab MR / GitHub PR review, parses structured reviewer output, deduplicates inline comments with hidden fingerprints, posts/upserts notes, and optionally emits diagnostics/OpenTelemetry data. Its own `CLAUDE.md` has the architecture map and the behavioral rules.
- `packages/agent-context` — `@weareikko/agent-context`: convention files, skills, marketplaces, MCP server configuration, the read-only MCP rule and the footer builders, shared by code-review and code-implementation. Its own `CLAUDE.md` has the architecture map.

The root package (`code-review`, private) holds the shared tooling. The GitHub Action (`action.yml`) and the reusable workflow (`.github/workflows/code-review.yml`) are at the root and run the published `@weareikko/code-review` with `npx`.

## Commands

Run them from the repository root:

- Install: `npm ci`
- Lint: `npm run lint`
- Format: `npm run format` / `npm run format:check`
- Typecheck (sources and tests of each package): `npm run typecheck`
- Unit tests (one Vitest project per package): `npm test`; one package: `npx vitest run --project code-review`
- Coverage: `npm run test:ci`
- Build (agent-context, then code-review): `npm run build`
- Full local check: `npm run check`
- Package contents: `npm pack --dry-run --workspaces`
- Evals: `npm run test:evals` (requires `ANTHROPIC_API_KEY` or `CODE_REVIEW_API_KEY` in the root `.env`; calls real LLMs)

## Monorepo layout

- `tsconfig.base.json`: compiler options. Each package has `tsconfig.json` (type check of `src`), `tsconfig.build.json` (declarations into `dist/`) and `tsconfig.test.json` (sources and tests).
- `vite.shared.ts`: `defineLibrary()`, the library build of each package (`vite.config.ts`): ES modules for Node 24, every bare import external, `__PKG_NAME__` / `__PKG_VERSION__` injected.
- `vitest.config.ts`: one project per package, coverage thresholds for all of them.
- `.oxlintrc.json`, `.oxfmtrc.json`, `.husky/`, `lint-staged`: shared by all packages.
- code-review depends on `@weareikko/agent-context` at `"*"` in the repository: npm links the workspace. Tests (Vitest `resolve.alias`) and type checks (TypeScript `paths` in `packages/code-review/tsconfig.json`) read the agent-context sources, so they need no build. `tsconfig.build.json` resets `paths`, so the declarations import the package. The publish job pins the dependency to the released version.
- Change the shared context, skill and MCP code in `packages/agent-context`, not in code-review.

## Coding conventions

- Use strict TypeScript and ESM imports with `.js` suffix for local runtime imports.
- Prefer small exported pure helpers with focused Vitest coverage.
- Keep runtime code Node 24-compatible and avoid CommonJS.
- Preserve oxlint/oxfmt style: 2 spaces, single quotes, semicolons, trailing commas, sorted imports.
- Do not add default exports unless matching existing patterns.
- Keep secrets out of logs, diagnostics, artifacts, and errors.
- Prefer typed project errors (`src/errors.ts` of each package) with actionable `hint` values.

## Release and repository notes

- Commit messages in history use Conventional Commits (`feat:`, `fix:`, `chore:`).
- **Never edit `CHANGELOG.md` directly.** One root `CHANGELOG.md` covers both packages. Each PR adds a fragment `.changelog/<slug>.md` (slug = branch name without its prefix, e.g. `feat/review-labels` → `review-labels.md`). Start an entry with the package name when it concerns one package only (`` `@weareikko/agent-context`: … ``).
- A fragment only contains `### Added|Changed|Deprecated|Removed|Fixed|Security|Dependencies` headings, each followed by its entries — no `#`/`##` heading. Mark breaking changes with a `**BREAKING**:` prefix under `### Changed`.
- **Do not write the PR number**: the release appends ` ([#N])` and its `[#N]: <url>` link definition from the merged PR that added the fragment. Other references (`[abc1234]` commits) need their link definition in the fragment.
- Entries are terse — ideally one line per change. Don't restate rationale, internals, or edge cases that the PR already covers.
- The `Changelog` check fails when a PR changes `packages/*/src/**`, `packages/*/bin/**`, `packages/code-review/skills/**`, `action.yml` or `.github/workflows/code-review.yml` without a fragment; set the `no-changelog` label for changes users do not see (tests, refactors, tooling). Format: [`weareikko/changelog`](https://github.com/weareikko/changelog).
- Each merge into `main` releases with the `Publish` workflow: it tests, then the `weareikko/changelog` action folds `.changelog/` into `CHANGELOG.md`, sets the version that the fragments give in the root and in both packages (`npm version --workspaces --include-workspace-root`; `version: auto`: a `**BREAKING**:` entry is a minor bump on 0.x, anything else a patch), commits `chore: release <version>`, tags, pushes, moves the `0` / `0.x` tags and creates the GitHub release; the last job pins `@weareikko/agent-context` in the code-review manifest and publishes both packages to npm. A merge without a fragment releases nothing. Do not tag or publish by hand.
- Prereleases: a PR adds `.changelog/prerelease` with the identifier (`alpha` / `beta` / `rc`); the next merges with fragments release prereleases (`0.11.1-beta.0`, `0.11.1-beta.1`…); a PR that deletes the file releases the stable version. A version with a `-` goes to the `next` npm dist-tag, is a GitHub prerelease and does not move the `0` / `0.x` tags.
- A manual run forces a bump: `gh workflow run publish.yml -f version=major` (or `patch` / `minor`). Prereleases only come from `.changelog/prerelease`.
- npm publishing uses trusted publishing (OIDC, no npm token), bound to `publish.yml` for each package: keep the publish job in that file. It skips a version that npm already has, so "Re-run failed jobs" on a failed `Publish to npm` job is safe. agent-context is published first: a failed agent-context publish stops the job before code-review is published.
- Release tags are plain semver (`0.3.1`), not `v0.3.1`; the pre-push hook rejects `v*` tags. The tags are shared by both packages.
- Published package files are limited by each `package.json#files`: code-review ships `dist/`, `bin/`, `skills/`, `LICENSE` and `README.md`; agent-context ships `dist/`, `LICENSE` and `README.md`.
- Do not edit generated `dist/`, `coverage/`, `node_modules/`, or test result artifacts.
