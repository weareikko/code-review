# Output format

← Back to the [README](../README.md)

## Review output format

Reviewer output is structured so each review reads the same way across runs, reviewers, and platforms. The same parsed output is posted to GitLab merge requests and GitHub pull requests; only the transport differs (see [How output maps to each platform](#how-output-maps-to-each-platform)).

**Inline comments** use the [Conventional Comments](https://conventionalcomments.org/) shape:

```md
<label> [decoration]: <Subject — short, action-oriented>

<Discussion: 1-2 sentences on the defect and impact, then the fix (often a `suggestion` block).>
```

Allowed labels: `issue`, `suggestion`, `nitpick`, `question`, `todo`, `chore`, `note`, `thought`. Decorations: `(blocking)`, `(non-blocking)`, `(if-minor)`. Severity ↔ label mapping is fixed:

| `severity` field | Comment header                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| `CRITICAL`       | `issue (blocking): ...`                                                        |
| `WARN`           | `issue: ...` (unmarked, implicitly blocking)                                   |
| `INFO`           | `nitpick:` / `suggestion (non-blocking):` / `note:` / `question:` / `thought:` |

**Summary** follows a fixed skeleton (each section is omitted if empty):

```md
### Overview

<2-3 sentences: what the MR does and the verdict.>

### Findings

<N> issue (blocking) · <N> issue · <N> suggestion · <N> nitpick

- **<label>** — `path/to/file.ts:42` — <subject only — not the discussion>

### Notes

<Suppressed findings (with the commit/ADR they reference), unreviewed files, or anything inline comments cannot carry.>
```

When there are no findings, the summary is exactly: `No issues found in the reviewed diff.`

The Findings bullets restate only the subject of each inline comment — the discussion, impact, and fix live in the inline comment itself, not in the summary.

## How output maps to each platform

The reviewer produces one platform-agnostic result — a set of inline comments and one `summary`. How it lands depends on the resolved platform:

|                 | **GitLab (merge request)**                   | **GitHub (pull request)**                                                                                                                                                                                                             |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inline comments | One positional MR **discussion** per finding | One **batched PR review** (`event: COMMENT`) carrying all inline comments in one call (no per-comment rate limits); on a 422 for an off-diff position it falls back to posting comments individually, dropping only the rejected ones |
| Summary         | An upserted non-positional **MR note**       | An upserted **issue comment**                                                                                                                                                                                                         |
| Posting modes   | `direct` or `draft` (atomic bulk publish)    | A single batched review (per-comment fallback on a 422); `draft` has no effect                                                                                                                                                        |

The hidden fingerprint markers and the summary marker are HTML comments, invisible in the rendered view; the reviewed-commit footer is a visible `<sub>` line (`Reviewed by … for commit <sha>.`) that the commit-skip guard parses. All render identically on both platforms, so deduplication, summary upsert, and the commit-skip guard work the same way on each.

## Summary note

In addition to inline comments, the reviewer returns an overall `summary` (Markdown). The CLI upserts it as a single non-positional comment — a **note** on the GitLab MR (`POST` / `PUT /merge_requests/:iid/notes/:id`) or an **issue comment** on the GitHub PR — the same shape a human reviewer creates when typing in the comment box. The comment carries a hidden marker:

```md
<!-- code-review:summary -->
```

On subsequent runs the CLI finds the existing comment by that marker and **updates it in place**, so the summary always reflects the latest review without piling up duplicates. The latest summary stays at the top of the comment. When it is updated, the previous latest summary is moved into a collapsed `<details>` section labeled `Previous review runs` instead of being erased; existing history is retained with a bounded limit of 10 previous runs.

The summary is upserted **before** inline comments are posted so it appears at the top of the review activity feed. It appends footer metadata after a horizontal rule so reviewers can see the run cost and reviewed commit at a glance:

```md
---

Review usage: 12,345 in / 678 out tokens — $0.0421 (anthropic/claude-sonnet-4-5, thinking: off)

Skills: [`code-review`](https://github.com/weareikko/code-review/blob/0.9.5/skills/code-review/SKILL.md), [`ikko-tools:dev/aria-apg`](https://gitlab.example.com/tools/ikko-tools/-/blob/main/plugins/dev/skills/aria-apg/SKILL.md)

Reviewed by [@weareikko/code-review](https://github.com/weareikko/code-review) for commit <sha>.
```

The `Review usage:` line names the model and records the `--thinking` level the run used (`thinking: off` by default). The `Skills:` line is only present when one or more skills were active for the run.

Each skill links to the `SKILL.md` the run loaded, so a reviewer can read the guidance the review was given:

| Skill source                                   | Link target                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in                                       | This package's repository at the released tag                                                                                                         |
| In-repo (`.claude/skills/`, `.agents/skills/`) | The repository under review at the reviewed commit — needs `CI_PROJECT_URL` (GitLab CI) or `GITHUB_SERVER_URL` + `GITHUB_REPOSITORY` (GitHub Actions) |
| `git:` / `git+ssh:`                            | The skill's repository at the pinned ref                                                                                                              |
| Marketplace                                    | The marketplace repository at its ref; shown under the full `<marketplace>:<plugin>/<skill>` name                                                     |
| `npm:`                                         | The package page on npmjs.com                                                                                                                         |
| `file:`                                        | Not linked — a local path is not reachable from a browser                                                                                             |

Credentials embedded in a clone URL are stripped from the link. A skill whose source cannot be resolved (a `file:` path, or an in-repo skill on a run with no CI project URL) keeps its plain name.

If a later CI job sees that the current head commit (of the MR or PR) already appears in that footer, it skips the agent run to avoid producing a different review for the same diff. Use `--force-review` or `CODE_REVIEW_FORCE_REVIEW=true` to bypass the guard. On GitLab the summary upsert runs in both `direct` and `draft` posting modes (it always uses the regular notes endpoints — the atomic bulk-publish flow is reserved for inline comments).

Disable with `--no-summary` or `CODE_REVIEW_POST_SUMMARY=false`. With `--dry-run`/`--no-post`, the summary is parsed but not posted, and the reviewed-commit skip guard is not applied.

## Inline comment footer

Each inline comment ends with a compact footer that mirrors the format used in the summary note:

```md
<sub>Reviewed by [@weareikko/code-review](https://github.com/weareikko/code-review) for commit <sha>.</sub>
```

This lets developers see at a glance whether a comment was posted during the current review pass or an earlier one — useful when a long-lived MR accumulates comments across many commits.

The footer is appended to the **payload body only**. Fingerprints are computed from the original reviewer output before the footer is added, so deduplication is unaffected by the SHA changing between review runs.

## Duplicate prevention

Each generated comment body includes hidden markers:

```md
<!-- code-review:fingerprint-primary:<hash> -->
<!-- code-review:fingerprint-secondary:<hash> -->
```

Before posting, the CLI fetches the existing review discussions (MR discussions on GitLab, the PR's review and issue comments on GitHub) and skips comments where either fingerprint is already present. This prevents reposting across reruns and also prevents duplicates generated in the same run.

The fingerprint markers, the summary marker (`<!-- code-review:summary -->`), and the reviewed-commit footer are read backward-compatibly: comments posted under the tool's former identity (the `gitlab-review:` marker prefix and the previous repository/product name in the footer) are still matched, so the first run after upgrading upserts and deduplicates against them rather than posting duplicates.
