# Skills

← Back to the [README](../README.md)

Skills are domain-specific review modules that sharpen the agent's focus on a particular class of bug or pattern. Each skill injects a focused instruction block and optional reference files into the system prompt.

## Built-in skills

| Name             | What it does                                                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-review`    | Adversarial correctness review: finds real, demonstrable bugs only. Reports nothing without a concrete proof path (specific input → failure → observable symptom). Includes per-language reference files for JavaScript/TypeScript and PHP/Laravel.                                       |
| `test-integrity` | Catches silent test tampering: test edits that hide a behavior change rather than track a genuine spec change. Flags weakened/deleted/disabled/rewritten assertions, snapshots, and lowered coverage thresholds (Vitest/Jest, PHPUnit), reporting only when a regression could be masked. |

Enable a built-in skill with `--skill`:

```bash
code-review --skill code-review
```

Or set it permanently via the environment variable:

```yml
variables:
  CODE_REVIEW_SKILLS: code-review
```

Multiple skills can be specified by repeating `--skill` or comma-separating values in `CODE_REVIEW_SKILLS`:

```bash
code-review --skill code-review --skill my-custom-skill
```

## External skills

A `--skill` value can carry a protocol prefix to load a skill from outside the package. The resolved directory must contain a `SKILL.md` in the same [agentskills.io](https://agentskills.io) format as project skills.

| Spec                                           | Resolves to                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `code-review`, `test-integrity`                | Built-in skills bundled with the package                                         |
| `npm:@scope/pkg`                               | `node_modules/@scope/pkg` (walked up from the working dir; monorepo-hoist aware) |
| `npm:@scope/bundle/security`                   | A `security/` sub-directory inside an installed npm bundle                       |
| `file:./path/to/skill`                         | A local path (relative paths resolve from the working dir)                       |
| `git:https://host/group/project.git`           | A shallow clone of the repo's default branch                                     |
| `git:https://host/group/bundle.git#v1.2.0/sec` | A clone pinned to ref `v1.2.0`, loading the `sec/` sub-directory                 |
| `git+ssh://git@host/group/project.git`         | A clone over SSH (recommended for private GitLab repos)                          |

### `git:` / `git+ssh:` skills

The repo is shallow-cloned at a **pinned ref** (a tag, branch, or commit). Append the ref — and an optional in-repo sub-directory — as a `#<ref>[/<subpath>]` fragment:

```bash
# repo root, default branch
code-review --skill git:https://gitlab.example.com/tools/review-skill.git

# pin a tag, load a sub-directory from a multi-skill bundle
code-review --skill 'git:https://gitlab.example.com/tools/skills.git#v1.2.0/security'

# private GitLab repo over SSH (preferred), pinned to a branch
code-review --skill 'git+ssh://git@gitlab.example.com/tools/skills.git#main'
```

Following the project's SSH-over-HTTPS convention, prefer `git+ssh://git@<host>/<group>/<project>.git` for private GitLab remotes — authentication then uses the SSH key already available to the runner. The scp-style shorthand (`git@host:group/project.git`) is intentionally not accepted, since its `:` collides with the `#ref` fragment; use the full `git+ssh://` URI instead.

Clones are cached on disk under `${XDG_CACHE_HOME:-~/.cache}/code-review/skills/`, keyed by URL and ref. A tag or commit ref is immutable, so the cache is reused indefinitely; a **branch** ref is also cached, so set `CODE_REVIEW_REFRESH_SKILLS=1` to re-clone when the branch has moved (or delete the cache directory).

## Project skills (auto-discovery)

Drop a skill directory anywhere between the git root and `cwd`. The reviewer walks up the tree and loads every skill it finds:

```
.agents/skills/<name>/SKILL.md      # preferred location
.claude/skills/<name>/SKILL.md      # alternative location
```

`SKILL.md` follows the [agentskills.io](https://agentskills.io) format — a YAML frontmatter block followed by the skill body:

```md
---
name: my-skill
description: One-line description shown in the summary footer.
---

Your skill instructions here. The reviewer reads these as part of its system prompt.
```

A `references/` subdirectory alongside `SKILL.md` is optional. Any files placed there are made available to the reviewer by path — the agent can read them on demand using its file-reading tool.

Project skills take precedence over built-in skills with the same name. A skill closer to `cwd` overrides one closer to the git root.

## Skills footer

When skills are active, their names appear in the MR summary note footer:

```md
Skills: `code-review`
```
