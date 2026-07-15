# Output format

← Back to the [README](../README.md)

## Review output format

Reviewer output is structured so each MR review reads the same way across runs and reviewers.

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

## MR-level summary note

In addition to inline discussions, the reviewer returns an overall `summary` (Markdown). The CLI posts it as a non-positional MR note — the same shape a human reviewer creates when typing in the MR comment box. The note carries a hidden marker:

```md
<!-- code-review:summary -->
```

On subsequent runs the CLI finds the existing note by that marker and **updates it in place** via `PUT /merge_requests/:iid/notes/:id`, so the summary always reflects the latest review without piling up duplicates. The latest summary stays at the top of the note. When a note is updated, the previous latest summary is moved into a collapsed `<details>` section labeled `Previous review runs` instead of being erased; existing history is retained with a bounded limit of 10 previous runs.

The summary is upserted **before** inline comments are posted so it appears at the top of the MR activity feed. It appends footer metadata after a horizontal rule so reviewers can see the run cost and reviewed commit at a glance:

```md
---

Review usage: 12,345 in / 678 out tokens — $0.0421 (anthropic/claude-sonnet-4-5, thinking: off)

Skills: `code-review`

Reviewed by [@weareikko/code-review](https://github.com/weareikko/gitlab-review) for commit <sha>.
```

The `Review usage:` line names the model and records the `--thinking` level the run used (`thinking: off` by default). The `Skills:` line is only present when one or more skills were active for the run.

If a later CI job sees that the current MR head commit already appears in that footer, it skips the agent run to avoid producing a different review for the same diff. Use `--force-review` or `CODE_REVIEW_FORCE_REVIEW=true` to bypass the guard. The summary upsert runs in both `direct` and `draft` posting modes (it always uses the regular notes endpoints — the atomic bulk-publish flow is reserved for inline comments).

Disable with `--no-summary` or `CODE_REVIEW_POST_SUMMARY=false`. With `--dry-run`/`--no-post`, the summary is parsed but not posted, and the reviewed-commit skip guard is not applied.

## Inline comment footer

Each inline comment ends with a compact footer that mirrors the format used in the summary note:

```md
<sub>Reviewed by [@weareikko/code-review](https://github.com/weareikko/gitlab-review) for commit <sha>.</sub>
```

This lets developers see at a glance whether a comment was posted during the current review pass or an earlier one — useful when a long-lived MR accumulates comments across many commits.

The footer is appended to the **payload body only**. Fingerprints are computed from the original reviewer output before the footer is added, so deduplication is unaffected by the SHA changing between review runs.

## Duplicate prevention

Each generated comment body includes hidden markers:

```md
<!-- code-review:fingerprint-primary:<hash> -->
<!-- code-review:fingerprint-secondary:<hash> -->
```

Before posting, the CLI fetches existing MR discussions and skips comments where either fingerprint is already present. This prevents reposting across reruns and also prevents duplicates generated in the same run.
