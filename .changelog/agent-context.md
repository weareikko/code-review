### Changed

- Move the convention files, skills, marketplaces, MCP server configuration, read-only MCP rule and footer builders to `@weareikko/agent-context`, shared with code-implementation (internal)
- **BREAKING**: Library API: `resolveSkillCacheDir` takes the product name (`resolveSkillCacheDir('code-review')`), and `loadNamedSkill` requires `cacheDir` in its options, plus `builtinSkillsDir` for a bare skill name. Both are now re-exported from `@weareikko/agent-context`

### Fixed

- Resolve a relative `file:` MCP spec from `--cwd`, not from the working directory of the process
