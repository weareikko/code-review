# CLAUDE.md

## Project

`@weareikko/agent-context` is a Node.js `>=24`, ESM TypeScript library shared by the weareikko pi agents (`@weareikko/code-review`, `code-implementation`). It loads convention files, skills (project, built-in, `npm:`, `file:`, `git:`, marketplace) and MCP server definitions, holds the MCP read-only rule, and builds the skill/MCP footer lines. It has no CLI and no agent runtime, and it never connects to an MCP server.

## Commands

- Install: `npm ci`
- Lint: `npm run lint`
- Format: `npm run format` / `npm run format:check`
- Typecheck: `npm run typecheck && npm run typecheck:tests`
- Unit tests: `npm test`
- Coverage: `npm run test:ci`
- Build: `npm run build`
- Full local check: `npm run check`

## Architecture map

- `src/index.ts`: the public API. Every export is listed in `docs/api.md`.
- `src/context-files.ts`: `walkUpContextFiles`, `CONVENTION_FILES`.
- `src/skills.ts`: skill specs, loaders, clone cache. `src/load-skills.ts`: the `loadSkills` aggregator.
- `src/marketplaces.ts`: Claude plugin marketplaces (skills and MCP servers).
- `src/mcp-parse.ts`: pure MCP document parsing and `${VAR}` expansion. `src/mcp-config.ts`: MCP sources and `resolveMcpServers`.
- `src/mcp-read-only.ts`: `isReadOnlyMcpTool`.
- `src/skill-links.ts`, `src/skill-usage.ts`, `src/footer.ts`: links, read counts, footer lines.

## Coding conventions

- Strict TypeScript, ESM imports with a `.js` suffix for local runtime imports.
- No tool-specific value in this package: the product name (`resolveSkillCacheDir(product)`), the variable prefix (`envPrefix`), the built-in skills directory and its link location are parameters.
- Keep secrets out of messages: redact URLs with `redactUrl`, and name variables, never values.
- Typed errors from `src/errors.ts` with an actionable `hint`.
- oxlint/oxfmt style: 2 spaces, single quotes, semicolons, trailing commas, sorted imports.

## Release and repository notes

- Commit messages use Conventional Commits (`feat:`, `fix:`, `chore:`).
- **Never edit `CHANGELOG.md` directly.** Each PR adds a fragment `.changelog/<slug>.md` with only `### Added|Changed|Deprecated|Removed|Fixed|Security|Dependencies` headings. Mark breaking changes with `**BREAKING**:` under `### Changed`. Do not write the PR number: the release adds it.
- The `Changelog` check fails when a PR changes `src/**` without a fragment; set the `no-changelog` label for changes users do not see.
- Each merge into `main` releases with the `Publish` workflow (`weareikko/changelog` action, then npm trusted publishing bound to `publish.yml`). Do not tag or publish by hand. Release tags are plain semver (`0.1.0`), not `v0.1.0`.
