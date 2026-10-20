# @weareikko/agent-context

Shared context, skills and MCP configuration for weareikko pi agents.

This library holds what the weareikko agents ([`@weareikko/code-review`](https://github.com/weareikko/code-review) and `code-implementation`) read before they start work on a repository, so that each agent gets the same features from the same code:

- **Convention files**: `AGENTS.md` / `CLAUDE.md`, walked from the git root down to the working directory.
- **Skills**: project skills in `.agents/skills` and `.claude/skills`, plus named skills from `npm:`, `file:`, `git:` / `git+ssh:` specs, Claude plugin marketplaces, and the tool's own built-in skills.
- **MCP server configuration**: marketplace plugins, `file:` documents, repository `.mcp.json` discovery (opt-in), `.claude/settings*.json` disable lists, `${VAR}` expansion from an allowlist, and shape validation.
- **The read-only rule** for MCP tools.
- **Footer builders**: skill links, skill read counts, and the MCP usage line.

It has no CLI and no agent runtime. It does not connect to MCP servers: each tool keeps its own bridge, prompts and posting code.

## Installation

```bash
npm install @weareikko/agent-context
```

Node.js 24 or later. ESM only.

## Usage

```ts
import {
  buildMarketplaceRegistry,
  CONVENTION_FILES,
  findGitRoot,
  loadSkills,
  parseMarketplaceEntry,
  pickMcpEnvVars,
  resolveMcpServers,
  resolveSkillCacheDir,
  walkUpContextFiles,
} from '@weareikko/agent-context';

const cwd = process.cwd();
const gitRoot = await findGitRoot(cwd);
const warn = (message: string) => console.warn(message);

// Each tool keeps its own configuration names and its own clone cache.
const envPrefix = 'CODE_REVIEW_';
const cacheDir = resolveSkillCacheDir('code-review');
const marketplaces = ['ikko=git+ssh://git@gitlab.example.com/ikko/ikko-tools.git#main'].map(
  parseMarketplaceEntry,
);

const conventions = await walkUpContextFiles(cwd, CONVENTION_FILES, gitRoot);

const skills = await loadSkills(cwd, gitRoot, ['ikko:dev/changelog', 'file:./skills/house'], {
  cacheDir,
  marketplaces,
  envPrefix,
  warn,
});

const mcpServers = await resolveMcpServers(
  { mcp: ['ikko:dev'], disableMcp: [], mcpDiscovery: false },
  cwd,
  gitRoot,
  buildMarketplaceRegistry(marketplaces),
  { cacheDir, vars: pickMcpEnvVars(process.env, ['JIRA_TOKEN']), envPrefix, warn },
);
```

## Tool-specific parameters

The library has no product name and no configuration prefix of its own. The calling tool passes them:

| Parameter          | Used for                                                                                                    | Example                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `cacheDir`         | The clone cache of `git:` skills and marketplaces. Build it with `resolveSkillCacheDir(product)`.           | `~/.cache/code-review/skills`   |
| `envPrefix`        | The variable names in hints and warnings: `<prefix>MARKETPLACES`, `<prefix>MCP_ENV`. Defaults to no prefix. | `CODE_REVIEW_`                  |
| `builtinSkillsDir` | The directory of the skills the tool ships. Bare skill names resolve against it.                            | `<package>/skills`              |
| `builtinSkills`    | In `SkillLinkContext`: where the footer links built-in skills (repository web URL, ref, and directory).     | `{ repoWebUrl, ref: '0.10.3' }` |

## Documentation

- [Context files](./docs/context.md): `walkUpContextFiles`, `CONVENTION_FILES`, `findGitRoot`.
- [Skills](./docs/skills.md): spec formats, project discovery, marketplaces, the clone cache.
- [MCP configuration](./docs/mcp.md): sources, shapes, `${VAR}` expansion, disable lists, the read-only rule.
- [Footer](./docs/footer.md): skill links, read counts, MCP usage line.
- [API reference](./docs/api.md): every export.

## Development

```bash
npm ci
npm run check   # lint, format, typecheck, tests
npm run build
```

Each pull request adds a fragment in `.changelog/` (format: [`weareikko/changelog`](https://github.com/weareikko/changelog)). Each merge into `main` releases with the `Publish` workflow, which publishes to npm with trusted publishing.

## License

[FSL-1.1-ALv2](./LICENSE)
