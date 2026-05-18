# @studiometa/gitlab-review

Run `pi-reviewer` in GitLab CI, parse its file output, and post per-file GitLab merge request discussions without duplicate comments.

Requires Node `>=24` and the runtime external tool `git`.

## Usage

```bash
npx @studiometa/gitlab-review
```

The package exposes the `gitlab-review` binary via a small shim at `bin/gitlab-review.js` that loads the compiled CLI.

## GitLab CI example

```yml
review:
  stage: post
  variables:
    GIT_DEPTH: 0
    NODE_VERSION: 24
  script:
    - npx @studiometa/gitlab-review
  artifacts:
    when: always
    paths:
      - pi-review.md
      - review-comments.json
```

## Configuration

Defaults are read from GitLab CI environment variables:

| Flag | Default |
| --- | --- |
| `--project` | `CI_PROJECT_ID` |
| `--mr` | `CI_MERGE_REQUEST_IID` |
| `--gitlab-url` | `CI_SERVER_URL` or `https://${CI_SERVER_HOST}` |
| `--gitlab-token` | `GITLAB_TOKEN`, `GLAB_CLI_TOKEN`, `CI_JOB_TOKEN`, or `GITLAB_PRIVATE_TOKEN` |
| `--model` | `PI_REVIEWER_MODEL` or `anthropic/claude-sonnet-4-5` |
| `--min-severity` | `PI_REVIEWER_MIN_SEVERITY` or `info` |
| `--api-key` | `PI_API_KEY`, `ANTHROPIC_API_KEY`, or `CLAUDE_API_KEY` |
| `--review-file` | `pi-review.md` |
| `--output` | `review-comments.json` |

Optional flags:

- `--dry-run`: generate artifacts and skip posting.
- `--no-post`: generate artifacts and skip posting.

## Artifacts

- `pi-review.md`: raw `pi-reviewer` output.
- `review-comments.json`: generated GitLab payloads, fingerprints, and duplicate status.

## Duplicate prevention

Every posted comment includes hidden markers:

```md
<!-- pi-reviewer:fingerprint-primary:<hash> -->
<!-- pi-reviewer:fingerprint-secondary:<hash> -->
```

Before posting, the CLI fetches existing MR discussions and skips comments whose primary or secondary fingerprint already exists. Fingerprints include file, side, normalized body, line where appropriate, and diff hunk context.

## Release process

1. Run `npm test && npm run build`.
2. Check package contents with `npm pack --dry-run`.
3. Bump the version in `package.json`.
4. Publish with `npm publish --access public`.

`pi-reviewer` is pinned to a GitHub commit SHA and listed as a bundled dependency so published packages use the expected reviewer version.

## Troubleshooting

- Ensure the job runs for merge requests and has `CI_PROJECT_ID` and `CI_MERGE_REQUEST_IID`.
- Use `GIT_DEPTH: 0` or allow the CLI to fetch missing history for `git diff target...HEAD`.
- Provide a token allowed to read MR metadata/discussions and create MR discussions.
- Provide `PI_API_KEY`, `ANTHROPIC_API_KEY`, or `CLAUDE_API_KEY` for `pi-reviewer`.
- Use `--dry-run` to inspect `pi-review.md` and `review-comments.json` before posting.
