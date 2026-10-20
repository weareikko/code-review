# Changelog

All notable changes to this project will be documented in this file. Each pull request adds a fragment in `.changelog/`; the Publish workflow folds them in here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.1 - 2026-10-20

### Added

- Load project conventions (`AGENTS.md`, `CLAUDE.md`), skills (repository, built-in, `npm:`, `file:`, `git:`, marketplace) and MCP server configuration (marketplace plugins, `file:`, repository `.mcp.json`, `.claude/settings.json` disable lists), moved from `@weareikko/code-review` ([#1])
- Read-only rule for MCP tools, and the skill links, skill usage and MCP lines of the footer ([#1])

[#1]: https://github.com/weareikko/agent-context/pull/1
