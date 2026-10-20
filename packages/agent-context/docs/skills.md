# Skills

← Back to the [README](../README.md)

A skill is a directory with a `SKILL.md` in the [agentskills.io](https://agentskills.io) format: a YAML frontmatter with `name` and `description`, then the instructions. An optional `references/` directory holds files the agent can read on demand.

```md
---
name: house-style
description: One-line description.
---

Instructions for the agent.
```

## `loadSkills(cwd, gitRoot, specs, options)`

Returns every skill for a run:

1. The project skills (see [Project skills](#project-skills)).
2. Each spec of `specs` that does not name a project skill, resolved with `loadNamedSkill` or, for a marketplace spec, `loadMarketplaceSkill`.

A spec that fails to load is skipped with a warning (`Skipping skill "<spec>": …`). A skill is guidance, not part of the work, so one bad spec does not stop the run.

| Option             | Notes                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| `cacheDir`         | Required. The clone cache, usually `resolveSkillCacheDir(product)`.             |
| `refresh`          | Clone `git:` skills and marketplaces again, even when a cached copy exists.     |
| `marketplaces`     | The registered marketplaces (`MarketplaceRef[]`, from `parseMarketplaceEntry`). |
| `builtinSkillsDir` | The tool's bundled skills. Without it, a bare name is skipped with a warning.   |
| `envPrefix`        | The tool's variable prefix, named in hints (`<prefix>MARKETPLACES`).            |
| `warn`             | Receives the warnings.                                                          |

## Project skills

`loadAutoDiscoveredSkills(cwd, gitRoot, warn?)` loads every skill in these directories, in each directory from `gitRoot` down to `cwd`:

```
.agents/skills/<name>/SKILL.md
.claude/skills/<name>/SKILL.md
```

A skill closer to `cwd` replaces one with the same name closer to the root. A `SKILL.md` without a valid `name` and `description` is skipped with a warning.

## Spec formats

`parseSkillSpec(spec, knownMarketplaces?)` reads these forms:

| Spec                                           | Resolves to                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `code-review`                                  | `<builtinSkillsDir>/code-review`                                          |
| `npm:@scope/pkg`                               | `node_modules/@scope/pkg`, walked up from `cwd` (monorepo hoisting works) |
| `npm:@scope/bundle/security`                   | The `security/` directory of an installed npm bundle                      |
| `file:./path/to/skill`                         | A local path. A relative path resolves from `cwd`.                        |
| `git:https://host/group/project.git`           | A shallow clone of the default branch                                     |
| `git:https://host/group/bundle.git#v1.2.0/sec` | A clone at ref `v1.2.0`, loading the `sec/` directory                     |
| `git+ssh://git@host/group/project.git`         | A clone over SSH (use this form for private GitLab repositories)          |
| `<marketplace>:<plugin>/<skill>`               | A skill in a registered marketplace, found through its manifest           |

A spec is a marketplace spec only when the part before `:` is a registered marketplace name. The scp-style form (`git@host:group/repo.git`) is not supported: use `git+ssh://`.

`loadNamedSkill(spec, cwd, options)` loads one non-marketplace spec and throws a `ConfigError` with a `hint` when it cannot.

## Marketplaces

A [Claude plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) is a git repository with a `.claude-plugin/marketplace.json` catalog that groups skills and MCP servers into plugins.

- `parseMarketplaceEntry('<name>=<[format:]url[#ref]>')` parses one declaration, such as `ikko=git+ssh://git@gitlab.example.com/ikko/tools.git#main`. The names `npm`, `file`, `git` and `builtin` are reserved. The only format is `anthropic`, the default.
- `buildMarketplaceRegistry(refs)` builds the name → ref map and rejects a duplicate name.
- `loadMarketplaceSkill(spec, registry, options)` clones the marketplace (or reuses the cache), finds the plugin in the manifest, and loads the skill from the plugin's `skills/` directory and from the `skills` paths of the manifest entry and `plugin.json`.

Every path read in a marketplace is checked after symlinks are resolved: a manifest or a symlink cannot make a read go out of the clone. Plugins with a remote `source` (`github`, `url`, `git-subdir`, `npm`) are not fetched.

## Clone cache

`git:` skills and marketplaces are cloned with `cloneGitRepo(url, ref, { cacheDir, refresh })` into `<cacheDir>/<gitSkillCacheKey(url, ref)>`. A clone goes to a temporary directory first and is renamed into place, so a failed or concurrent clone never leaves a partial cache entry.

`resolveSkillCacheDir(product)` returns `${XDG_CACHE_HOME:-~/.cache}/<product>/skills`. Each tool passes its own product name, so two tools never share a cache.

A branch ref stays cached. Pass `refresh: true` to clone again when the branch has moved.

Credentials in a URL are removed from every message with `redactUrl`.
