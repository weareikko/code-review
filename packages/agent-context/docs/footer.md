# Footer

← Back to the [README](../README.md)

The footer of an agent note tells the reader which skills and MCP servers the run used.

```md
Skills: [`code-review`](https://github.com/weareikko/code-review/blob/0.10.3/skills/code-review/SKILL.md) (read), [`ikko:dev/aria-apg`](https://gitlab.example.com/ikko/tools/-/blob/main/plugins/dev/skills/aria-apg/SKILL.md) (not read)
MCP: [jira](https://gitlab.example.com/group/app/-/blob/abc123/.mcp.json) (2 calls), docs (unused), context7 (unavailable)
```

## Skill reads

`createSkillReadCounter(skills, cwd)` returns a counter. Feed it every tool call with `record(toolName, args)`. A call of the built-in `read` tool whose `path` is under a skill directory counts as a read of that skill. `countFor(skill)` returns the count.

- `readToolPath(toolName, args)`: the path of a `read` call, or `undefined`.
- `findSkillForPath(skills, path, cwd)`: the skill whose directory holds `path`.
- `formatSkillUsageState({ reads })`: `read` or `not read`.

## MCP usage

`formatMcpUsageState({ status, calls })`: `unavailable`, `unused`, `1 call` or `N calls`.

`formatReviewUsageSummary({ skills, mcp })`: the log line `Usage: skills a (read); MCP b (1 call)`, or `undefined` when there is nothing to show.

## Footer lines

- `formatSkillsFooter(skills, context)`: the `Skills:` line, or `undefined` when no skill was loaded.
- `formatMcpFooter(servers, context)`: the `MCP:` line, or `undefined` when no server was configured.

## Links

`SkillLinkContext` gives the coordinates links need:

| Field           | Notes                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `projectWebUrl` | Web URL of the repository the agent works on (`CI_PROJECT_URL`, or `GITHUB_SERVER_URL/GITHUB_REPOSITORY`). |
| `commitSha`     | The commit the agent worked on.                                                                            |
| `builtinSkills` | `{ repoWebUrl, ref, path? }`: where the tool publishes its built-in skills. `path` defaults to `skills`.   |

What each source links to (`skillSourceUrl`, `mcpSourceUrl`):

| Source        | Link                                                                               |
| ------------- | ---------------------------------------------------------------------------------- |
| `builtin`     | `<builtinSkills.repoWebUrl>/blob/<ref>/<path>/<name>/SKILL.md`; none without it    |
| `project`     | The file at `commitSha` in `projectWebUrl`; none without both                      |
| `npm`         | The npm package page                                                               |
| `git`         | The `SKILL.md` at the pinned ref in the repository                                 |
| `marketplace` | The `SKILL.md` (skill) or the plugin directory (MCP server) at the marketplace ref |
| `file`        | None                                                                               |

`blobUrl` builds GitHub links (`/blob/`) for `github.com` and GitLab links (`/-/blob/`) for every other host. `gitRepoWebUrl` converts a clone URL (HTTPS, SSH, `git+ssh://`, scp-style) to an HTTPS web URL and removes credentials.

A marketplace skill shows as `<marketplace>:<plugin>/<skill>` (`skillDisplayName`), the selector a developer puts in a skill list.
