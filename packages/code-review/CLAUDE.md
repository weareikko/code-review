# CLAUDE.md — @weareikko/code-review

The commands, conventions and release notes of the monorepo are in the root `CLAUDE.md`. Paths below are relative to `packages/code-review`.

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
- `src/product.ts`: the product name, links, environment prefix, and the built-in skills location passed to agent-context.
- `src/review.ts`: public library exports.
- `@weareikko/agent-context` (`packages/agent-context`): convention files, skills, marketplaces, MCP server configuration, the read-only MCP rule and the footer builders, shared with code-implementation. Change them in that package, not here.
- `skills/code-review/`: built-in skill packaged with the npm artifact. The footer links it at `packages/code-review/skills` of the version tag.
- `tests/evals/`: LLM-backed evaluation tests and fixtures.
- `scripts/`: `docs-mcp.mjs` (the `docs` MCP server of the root `.mcp.json`) and `snapshot-mr.mjs` (eval fixtures from a real MR).

## Behavioral rules

- Keep reviewer output parsing backwards-compatible with legacy `pi-reviewer` markers where existing code already supports them.
- Do not change fingerprint marker formats, summary markers, or reviewed-commit footer formats without migration tests.
- Keep `draft` posting atomic: cleanup orphan drafts, create drafts, re-check fingerprints, then bulk publish.
- Summary notes are non-positional MR notes and should be upserted, not duplicated.
- Dry-run/no-post must write artifacts but never post to GitLab.
- Noise filtering should continue to skip lockfiles, generated files, build output, coverage, and declaration files.

## Testing guidance

- Add/update unit tests next to changed source files (`src/*.test.ts`).
- Test files are type-checked (`tsconfig.test.json`). Build a partial `Config` fixture with `partialConfig()` from `tests/partial-config.ts`.
- For config/CLI changes, cover CLI flags and env fallbacks.
- For GitLab API changes, mock `fetch` and assert URL, method, headers, and body.
- For posting changes, test duplicate handling, draft cleanup, race deletion, and publish counts.
- For parser/fingerprint changes, test marker stripping and legacy compatibility.
- For reviewer prompt/skill changes, update `src/gitlab-review.test.ts`; only use evals when model behavior matters.
