# CLAUDE.md — @weareikko/agent-context

The commands, conventions and release notes of the monorepo are in the root `CLAUDE.md`. Paths below are relative to `packages/agent-context`.

## Project

`@weareikko/agent-context` is a Node.js `>=24`, ESM TypeScript library shared by the weareikko pi agents (`@weareikko/code-review`, `code-implementation`). It loads convention files, skills (project, built-in, `npm:`, `file:`, `git:`, marketplace) and MCP server definitions, holds the MCP read-only rule, and builds the skill/MCP footer lines. It has no CLI and no agent runtime, and it never connects to an MCP server.

## Architecture map

- `src/index.ts`: the public API. Every export is listed in `docs/api.md`.
- `src/context-files.ts`: `walkUpContextFiles`, `CONVENTION_FILES`.
- `src/project-config-reader.ts`: working-tree and frozen Git-revision readers for repository-controlled configuration.
- `src/skills.ts`: skill specs, loaders, clone cache. `src/load-skills.ts`: the `loadSkills` aggregator.
- `src/marketplaces.ts`: Claude plugin marketplaces (skills and MCP servers).
- `src/mcp-parse.ts`: pure MCP document parsing and `${VAR}` expansion. `src/mcp-config.ts`: MCP sources and `resolveMcpServers`.
- `src/mcp-read-only.ts`: `isReadOnlyMcpTool`.
- `src/skill-links.ts`, `src/skill-usage.ts`, `src/footer.ts`: links, read counts, footer lines.

## Coding conventions

- No tool-specific value in this package: the product name (`resolveSkillCacheDir(product)`), the variable prefix (`envPrefix`), the built-in skills directory and its link location are parameters.
- Keep secrets out of messages: redact URLs with `redactUrl`, and name variables, never values.
- Typed errors from `src/errors.ts` with an actionable `hint`.
- A change to the public API updates `docs/api.md`, and the code-review package if it uses that export.
