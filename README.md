# @ikko-dev/gitlab-review

Run an agent-driven code review in GitLab CI, parse inline comments, post deduplicated merge request discussions, and report per-run token usage and cost.

## Requirements

- Node.js `>=24`
- `git` available in the runtime
- A pipeline running in a merge request context (`CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`)

## Install / Run

Run without installing:

```bash
npx @ikko-dev/gitlab-review
```

Or install in your project:

```bash
npm i -D @ikko-dev/gitlab-review
npx gitlab-review --help
```

### Binary entrypoint

This package exposes the `gitlab-review` binary through:

- `bin/gitlab-review.js` (runtime shim)
- `dist/cli.js` (compiled CLI)

## Usage

```bash
gitlab-review [options]
```

Common local dry-run:

```bash
gitlab-review \
  --project 123 \
  --mr 42 \
  --gitlab-url https://gitlab.example.com \
  --gitlab-token "$GITLAB_TOKEN" \
  --api-key "$PI_API_KEY" \
  --dry-run
```

## GitLab CI example

```yml
review:
  image: node:24
  stage: post
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: '0'
  script:
    - npx @studiometa/gitlab-review
  artifacts:
    when: always
    paths:
      - pi-review.md
      - review-comments.json
      - review-usage.json
```

## Environment variables

The CLI auto-resolves values from CI variables and common token/key names.

| Variable                     | Purpose                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `CI_PROJECT_ID`              | Default for `--project`                                  |
| `CI_MERGE_REQUEST_IID`       | Default for `--mr`                                       |
| `CI_SERVER_URL`              | Default for `--gitlab-url`                               |
| `CI_SERVER_HOST`             | Fallback for `--gitlab-url` as `https://$CI_SERVER_HOST` |
| `GITLAB_TOKEN`               | Preferred GitLab API token (`PRIVATE-TOKEN`)             |
| `GLAB_CLI_TOKEN`             | Fallback GitLab API token (`PRIVATE-TOKEN`)              |
| `CI_JOB_TOKEN`               | Fallback token (`JOB-TOKEN`)                             |
| `GITLAB_PRIVATE_TOKEN`       | Fallback token (`PRIVATE-TOKEN`)                         |
| `PI_API_KEY`                 | Preferred AI API key                                     |
| `ANTHROPIC_API_KEY`          | Fallback AI API key                                      |
| `CLAUDE_API_KEY`             | Fallback AI API key                                      |
| `PI_REVIEWER_MODEL`          | Default for `--model`                                    |
| `PI_REVIEWER_MIN_SEVERITY`   | Default for `--min-severity`                             |
| `PI_REVIEWER_THINKING_LEVEL` | Default for `--thinking`                                 |
| `PI_REVIEWER_POSTING_MODE`   | Default for `--posting-mode`                             |

## Flags

| Flag                     | Description                                        | Default                                                                  |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------ |
| `--project <id>`         | GitLab project ID/path                             | `CI_PROJECT_ID`                                                          |
| `--mr <iid>`             | Merge request IID                                  | `CI_MERGE_REQUEST_IID`                                                   |
| `--gitlab-url <url>`     | GitLab URL                                         | `CI_SERVER_URL` or `https://${CI_SERVER_HOST}`                           |
| `--gitlab-token <token>` | GitLab token                                       | `GITLAB_TOKEN`, `GLAB_CLI_TOKEN`, `CI_JOB_TOKEN`, `GITLAB_PRIVATE_TOKEN` |
| `--api-key <key>`        | API key passed to the review agent                 | `PI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`                      |
| `--model <provider/id>`  | Model passed to the review agent                   | `PI_REVIEWER_MODEL` or `anthropic/claude-sonnet-4-5`                     |
| `--min-severity <level>` | `info`, `warn`, `critical`                         | `PI_REVIEWER_MIN_SEVERITY` or `info`                                     |
| `--thinking <level>`     | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | `PI_REVIEWER_THINKING_LEVEL` or `off`                                    |
| `--posting-mode <mode>`  | `direct` or `draft` (atomic bulk publish)          | `PI_REVIEWER_POSTING_MODE` or `direct`                                   |
| `--review-file <path>`   | Raw `pi-reviewer` output file                      | `pi-review.md`                                                           |
| `--output <path>`        | Generated payload artifact file                    | `review-comments.json`                                                   |
| `--cwd <path>`           | Working directory                                  | `process.cwd()`                                                          |
| `--dry-run`              | Generate artifacts and skip posting                | `false`                                                                  |
| `--no-post`              | Same behavior as `--dry-run`                       | `false`                                                                  |
| `--help`, `-h`           | Show help                                          | -                                                                        |
| `--version`, `-v`        | Show version                                       | -                                                                        |

`--thinking` controls extended thinking on the underlying agent. Thinking tokens are billed at the model's output token rate, so higher levels cost more — the `Review usage:` line and `review-usage.json` reflect that cost.

`--posting-mode draft` creates GitLab draft notes for every fresh comment and publishes them atomically via `POST /draft_notes/bulk_publish`. The reviewer either appears fully on the MR or not at all, instead of leaking partial state if the job is interrupted. Requires a GitLab version that exposes the `draft_notes` and `bulk_publish` endpoints (≥ 15.10) and a token whose user can own draft notes — keep `direct` for older self-hosted instances or restricted tokens.

## Artifacts

- `pi-review.md`: raw review text returned by the agent
- `review-comments.json`: generated comment objects including:
  - parsed comment payload
  - computed fingerprints
  - duplicate status
  - final GitLab discussion payload
- `review-usage.json`: token and cost breakdown for the run (`tokens.{input,output,cacheRead,cacheWrite,total}`, `cost.{input,output,cacheRead,cacheWrite,total}`, `model`)

The CLI also prints a one-line summary at the end of the run:

```
Review usage: 12,345 in / 678 out tokens — $0.0421 (anthropic/claude-sonnet-4-5)
```

Use these files for CI debugging and auditing.

## Diagnostics channels

`gitlab-review` publishes opt-in Node.js `diagnostics_channel` tracing events with no external telemetry dependency. Subscribers can listen before calling `run()` or from a Node preload/import hook before running the CLI.

Base tracing channel names:

- `@ikko-dev/gitlab-review:run`
- `@ikko-dev/gitlab-review:gitlab.get_merge_request`
- `@ikko-dev/gitlab-review:gitlab.get_latest_version`
- `@ikko-dev/gitlab-review:git.prepare_history`
- `@ikko-dev/gitlab-review:git.get_merge_diff`
- `@ikko-dev/gitlab-review:reviewer.run`
- `@ikko-dev/gitlab-review:review.parse`
- `@ikko-dev/gitlab-review:gitlab.get_discussions`
- `@ikko-dev/gitlab-review:comments.build`
- `@ikko-dev/gitlab-review:artifact.write_output`
- `@ikko-dev/gitlab-review:gitlab.post_comments`

Node emits tracing subchannels as `tracing:<base>:start`, `:end`, `:asyncStart`, `:asyncEnd`, and `:error`. Payloads include safe run metadata (`runId`, phase, project, MR, GitLab URL, model, severity, timings, comment counts, and sanitized `errorInfo`) and intentionally exclude tokens/API keys.

```js
import { diagnosticChannels, run } from '@ikko-dev/gitlab-review';

const onStart = (ctx) => console.log('review started', ctx.runId);
const onEnd = (ctx) => console.log('review completed', ctx.durationMs, ctx.generated);
const onError = (ctx) => console.error('review failed', ctx.errorInfo);

diagnosticChannels.run.start.subscribe(onStart);
diagnosticChannels.run.asyncEnd.subscribe(onEnd);
diagnosticChannels.run.error.subscribe(onError);

await run(config);
```

## Duplicate prevention

Each generated comment body includes hidden markers:

```md
<!-- pi-reviewer:fingerprint-primary:<hash> -->
<!-- pi-reviewer:fingerprint-secondary:<hash> -->
```

Before posting, the CLI fetches existing MR discussions and skips comments where either fingerprint is already present. This prevents reposting across reruns and also prevents duplicates generated in the same run.

## Troubleshooting

- **`Node.js >=24 is required`**
  - Use `node:24` (or newer) in CI.
- **`Missing required configuration`**
  - Provide required flags or ensure CI vars are available (`CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, token, API key).
- **`--min-severity must be one of: info, warn, critical`**
  - Fix `--min-severity` or `PI_REVIEWER_MIN_SEVERITY`.
- **Git history errors / merge-base failures**
  - Set `GIT_DEPTH: 0`.
  - Ensure source and target branches are fetchable from `origin`.
- **GitLab API 401/403 when posting**
  - Ensure token has rights to read MR metadata/discussions and create MR discussions.
  - If using `CI_JOB_TOKEN`, ensure your GitLab project settings allow required API access.
- **No comments posted**
  - Check `review-comments.json` for `duplicate: true` or empty parsed comments.
  - Run with `--dry-run` and inspect `pi-review.md` formatting (`== Inline Comments ==`).

## Development / release

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The review agent runs against pinned `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` versions, so published builds keep a deterministic reviewer runtime.
