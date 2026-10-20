# Contributing

## Layout

This repository is an npm workspaces monorepo. The root package is private and holds the shared tooling; each package is in `packages/`:

- `packages/code-review`: `@weareikko/code-review`, the CLI (`bin/`, `src/cli.ts`) and library (`src/review.ts`), its built-in skills (`skills/`), tests (`src/*.test.ts`, `tests/`), LLM evals (`tests/evals/`) and docs (`docs/`).
- `packages/agent-context`: `@weareikko/agent-context`, the context, skill and MCP configuration library (`src/`, `docs/`).
- At the root: the GitHub Action (`action.yml`), the workflows (`.github/workflows/`), the shared configuration (`tsconfig.base.json`, `vite.shared.ts`, `vitest.config.ts`, `.oxlintrc.json`, `.oxfmtrc.json`, `.husky/`), `CHANGELOG.md` and `.changelog/`.

code-review depends on agent-context. In the repository the dependency is `"*"`, so npm links the workspace package; the publish workflow pins it to the released version. Tests and type checks read the agent-context sources (Vitest alias, TypeScript `paths`), so they run before a build.

## Development

Node.js 24 or later. Run every command from the repository root:

```sh
npm ci
npm run lint          # oxlint
npm run format:check  # oxfmt (npm run format writes)
npm run typecheck     # tsgo on the sources and the tests of each package
npm test              # Vitest: one project per package
npm run test:ci       # the same, with coverage
npm run build         # agent-context, then code-review
npm run check         # lint, format, type check and tests (the CI gate)
npm run test:evals    # code-review LLM evals: real API calls, keys in .env
```

`npm pack --dry-run --workspaces` lists the files that each package publishes.

## Changelog and releases

A pull request that changes what ships adds a fragment `.changelog/<slug>.md` with [`weareikko/changelog`](https://github.com/weareikko/changelog): one or more `###` sections of Keep a Changelog (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Dependencies`), each with short entries and no pull request number. Start an entry with the package name when it concerns one package only (`` `@weareikko/agent-context`: … ``). The `Changelog` workflow requires a fragment for `packages/*/src/**`, `packages/*/bin/**`, `packages/code-review/skills/**`, `action.yml` and `.github/workflows/code-review.yml`; the `no-changelog` label skips the check for tests, docs and tooling.

Each merge into `main` runs `.github/workflows/publish.yml`. It tests, then folds the fragments into [`CHANGELOG.md`](CHANGELOG.md), computes the next version from them, sets it in the root and in each package (`npm version --workspaces --include-workspace-root`), commits `chore: release <version>`, tags the version, moves the `0` / `0.x` tags of the GitHub Action and creates the GitHub release. The last job publishes `@weareikko/agent-context` and `@weareikko/code-review` to npm with trusted publishing and provenance; a version that npm already has is skipped, so "Re-run failed jobs" is safe. `gh workflow run publish.yml -f version=minor` forces a bump. Do not tag or publish by hand.

The fragments give the version ([automatic version](https://github.com/weareikko/changelog#automatic-version)):

| Entries                                    | From 1.0.0 | On 0.x |
| ------------------------------------------ | ---------- | ------ |
| A breaking entry (`**BREAKING**: …`)       | major      | minor  |
| An entry under `Added`, no breaking entry  | minor      | patch  |
| Other entries only (fixes, `Dependencies`) | patch      | patch  |

Prereleases follow the file `.changelog/prerelease` ([prereleases](https://github.com/weareikko/changelog#prereleases)): a pull request that adds it with `beta` makes the next merges with fragments release prereleases; a pull request that deletes it releases the stable version. A prerelease goes to the `next` npm dist-tag, is a GitHub prerelease and does not move the `0` / `0.x` tags.
