# API reference

← Back to the [README](../README.md)

Every export of `@weareikko/agent-context`. The JSDoc of each function in `src/` has the full contract.

## Errors

| Export                     | Kind     | Notes                                                             |
| -------------------------- | -------- | ----------------------------------------------------------------- |
| `AgentContextError`        | class    | Base class. `code` and an optional `hint` with the next step.     |
| `ConfigError`              | class    | A spec that cannot be parsed or resolved. `code: 'CONFIG_ERROR'`. |
| `GitError`                 | class    | A failed `git` command. `code: 'GIT_ERROR'`, `hint` = git output. |
| `formatError(error)`       | function | `[CODE] message` and `Hint: …`, or the plain message.             |
| `AgentContextErrorCode`    | type     |                                                                   |
| `AgentContextErrorOptions` | type     |                                                                   |

## Git and paths

| Export                   | Kind     | Notes                                                 |
| ------------------------ | -------- | ----------------------------------------------------- |
| `findGitRoot(cwd)`       | function | Work tree root, or `cwd` outside a work tree.         |
| `git(args, options?)`    | function | Runs `git`, returns stdout, throws `GitError`.        |
| `walkDirs(cwd, gitRoot)` | function | Directories from `gitRoot` down to `cwd`, root first. |
| `toPosixPath(path)`      | function | `/`-separated path.                                   |
| `GitOptions`             | type     |                                                       |

## Context files — [docs](./context.md)

| Export                                        | Kind     |
| --------------------------------------------- | -------- |
| `walkUpContextFiles(cwd, filenames, gitRoot)` | function |
| `CONVENTION_FILES`                            | constant |
| `CONFIG_DIRS`                                 | constant |
| `ContextFile`                                 | type     |

## Skills — [docs](./skills.md)

| Export                                          | Kind     |
| ----------------------------------------------- | -------- |
| `loadSkills(cwd, gitRoot, specs, options)`      | function |
| `loadAutoDiscoveredSkills(cwd, gitRoot, warn?)` | function |
| `loadNamedSkill(spec, cwd, options)`            | function |
| `loadBuiltinSkill(name, builtinSkillsDir)`      | function |
| `loadSkillFromDir(dir, origin)`                 | function |
| `parseSkillSpec(spec, knownMarketplaces?)`      | function |
| `resolveNpmSkillDir(packageName, subpath, cwd)` | function |
| `cloneGitRepo(url, ref, { cacheDir, refresh })` | function |
| `resolveSkillCacheDir(product)`                 | function |
| `gitSkillCacheKey(url, ref)`                    | function |
| `normalizeGitUrl(url)`                          | function |
| `redactUrl(url)`                                | function |
| `Skill`, `SkillOrigin`, `SkillSpec`             | types    |
| `LoadNamedSkillOptions`, `LoadSkillsOptions`    | types    |

## Marketplaces — [docs](./skills.md#marketplaces)

| Export                                               | Kind      |
| ---------------------------------------------------- | --------- |
| `parseMarketplaceEntry(entry)`                       | function  |
| `buildMarketplaceRegistry(refs)`                     | function  |
| `loadMarketplaceSkill(spec, registry, options)`      | function  |
| `loadMarketplaceMcpServers(spec, registry, options)` | function  |
| `MARKETPLACE_FORMATS`, `DEFAULT_MARKETPLACE_FORMAT`  | constants |
| `RESERVED_MARKETPLACE_NAMES`                         | constant  |
| `MarketplaceRef`, `MarketplaceRegistry`              | types     |
| `MarketplaceFormat`, `MarketplaceMcpSpec`            | types     |
| `LoadMarketplaceOptions`                             | type      |

## MCP configuration — [docs](./mcp.md)

| Export                                                        | Kind     |
| ------------------------------------------------------------- | -------- |
| `resolveMcpServers(config, cwd, gitRoot, registry, options)`  | function |
| `loadAutoDiscoveredMcpServers(cwd, gitRoot, warn?, options?)` | function |
| `loadMcpDisableFilters(cwd, gitRoot, warn?)`                  | function |
| `parseMcpSpec(spec)`                                          | function |
| `parseMcpServers(raw, source, options?)`                      | function |
| `normalizeMcpServer(name, raw, source, options?)`             | function |
| `extractMcpServerMap(raw)`                                    | function |
| `expandMcpTemplate(value, vars)`                              | function |
| `pickMcpEnvVars(env, allowlist)`                              | function |
| `dropEmptyHeaders(headers)`                                   | function |
| `parseMcpDisableFilters(raw)`                                 | function |
| `applyMcpDisableFilters(servers, filters)`                    | function |
| `isReadOnlyMcpTool(tool)`                                     | function |
| `MAX_MCP_TIMEOUT_MS`                                          | constant |
| `McpServerConfig`, `McpServerSource`, `McpTransportType`      | types    |
| `McpEnvVars`, `McpDisableFilters`, `McpSpec`                  | types    |
| `McpServerSourcesConfig`, `ResolveMcpServersOptions`          | types    |
| `LoadAutoDiscoveredMcpServersOptions`                         | type     |
| `NormalizeMcpServerOptions`, `McpToolAnnotations`             | types    |

## Links, usage and footer — [docs](./footer.md)

| Export                                      | Kind     |
| ------------------------------------------- | -------- |
| `formatSkillsFooter(skills, context?)`      | function |
| `formatMcpFooter(servers, context?)`        | function |
| `formatSkillLink(skill, context?)`          | function |
| `skillDisplayName(skill)`                   | function |
| `skillSourceUrl(origin, context?)`          | function |
| `mcpSourceUrl(source, context?)`            | function |
| `blobUrl(repoWebUrl, ref, path, kind?)`     | function |
| `gitRepoWebUrl(cloneUrl)`                   | function |
| `createSkillReadCounter(skills, cwd)`       | function |
| `readToolPath(toolName, args)`              | function |
| `findSkillForPath(skills, path, cwd)`       | function |
| `formatSkillUsageState(skill)`              | function |
| `formatMcpUsageState(server)`               | function |
| `formatReviewUsageSummary(usage)`           | function |
| `SkillLinkContext`, `BuiltinSkillsLocation` | types    |
| `SkillRef`, `SkillUsage`, `McpServerUsage`  | types    |
| `SkillReadCounter`, `SkillReadTarget`       | types    |
