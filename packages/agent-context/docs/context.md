# Context files

← Back to the [README](../README.md)

## `walkUpContextFiles(cwd, filenames, gitRoot)`

Reads one context file per directory, from `gitRoot` down to `cwd`. The result is root first, so the file closest to `cwd` comes last and reads as the most specific.

In each directory, the function looks for the first name of `filenames` (case-insensitive) in the directory itself, then in each of `CONFIG_DIRS` (`.pi`, `.claude`, `.agents`). The first match wins for that directory.

```ts
const conventions = await walkUpContextFiles(cwd, CONVENTION_FILES, gitRoot);
// [{ path: '../../AGENTS.md', content: '…' }, { path: 'AGENTS.md', content: '…' }]
```

Each `ContextFile` has:

| Field     | Notes                                                    |
| --------- | -------------------------------------------------------- |
| `path`    | Relative to `cwd`. Use it to label the file in a prompt. |
| `content` | The file content, UTF-8.                                 |

## `CONVENTION_FILES`

`['AGENTS.md', 'CLAUDE.md']`: the project convention files. `AGENTS.md` wins over `CLAUDE.md` in the same directory.

A tool can pass its own list. code-review reads its review rules with `walkUpContextFiles(cwd, ['REVIEW.md'], gitRoot)`.

## `findGitRoot(cwd)`

Returns the top-level directory of the git work tree that holds `cwd`, or `cwd` when it is not in a work tree. All the "walk from the git root to `cwd`" functions of this library take this value as `gitRoot`.

## `walkDirs(cwd, gitRoot)`

The directories from `gitRoot` down to `cwd`, root first. When `cwd` is not under `gitRoot`, the walk stops at the filesystem root.
