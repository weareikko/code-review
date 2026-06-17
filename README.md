# @ikko-dev/gitlab-review

[![NPM Version](https://img.shields.io/npm/v/@ikko-dev/gitlab-review.svg?style=flat&colorB=3e63dd&colorA=414853)](https://www.npmjs.com/package/@ikko-dev/gitlab-review/)
[![Downloads](https://img.shields.io/npm/dm/@ikko-dev/gitlab-review?style=flat&colorB=3e63dd&colorA=414853)](https://www.npmjs.com/package/@ikko-dev/gitlab-review/)
[![Size](https://img.shields.io/bundlephobia/minzip/@ikko-dev/gitlab-review?style=flat&colorB=3e63dd&colorA=414853&label=size)](https://bundlephobia.com/package/@ikko-dev/gitlab-review)
![Codecov](https://img.shields.io/codecov/c/github/ikko-dev/gitlab-review?style=flat&colorB=3e63dd&colorA=414853)

Run an agent-driven code review in GitLab CI, parse inline comments, post deduplicated merge request discussions, and report per-run token usage and cost.

The reviewer reads the MR **title and description** as the author's declared intent: it checks the diff against the stated purpose and flags code/intent mismatches (the change does something the description never claimed, or omits something it promised) as a first-class finding. A missing or empty description degrades gracefully — the review still runs.

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
  --model anthropic/claude-sonnet-4-5 \
  --api-key "$ANTHROPIC_API_KEY" \
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
    # A model is required (no default). Provide its provider's key as a masked
    # CI/CD variable, e.g. ANTHROPIC_API_KEY.
    GITLAB_REVIEW_MODEL: anthropic/claude-sonnet-4-5
  script:
    - npx @ikko-dev/gitlab-review
  artifacts:
    when: always
    paths:
      - gitlab-review.md
      - review-comments.json
      - review-usage.json
```

## Documentation

The README covers getting started. Reference material lives in [`docs/`](https://github.com/ikko-dev/gitlab-review/tree/main/docs):

- [Configuration](https://github.com/ikko-dev/gitlab-review/blob/main/docs/configuration.md) — full environment-variable and CLI-flag reference, plus the `GITLAB_REVIEW_` namespacing convention.
- [Providers](https://github.com/ikko-dev/gitlab-review/blob/main/docs/providers.md) — Anthropic, OpenRouter, Gemini, Ollama, and OpenAI-compatible endpoints, plus heterogeneous review with a model pool.
- [Skills](https://github.com/ikko-dev/gitlab-review/blob/main/docs/skills.md) — built-in, external (`npm:`/`file:`/`git:`), and project auto-discovered review skills.
- [Multi-stage review](https://github.com/ikko-dev/gitlab-review/blob/main/docs/multi-stage-review.md) — the staged Find / Verify / Synthesize pipeline behind `--review-depth`.
- [Observability](https://github.com/ikko-dev/gitlab-review/blob/main/docs/observability.md) — diagnostics-channel tracing and the opt-in OpenTelemetry bridge (spans, metrics, logs).
- [Output format](https://github.com/ikko-dev/gitlab-review/blob/main/docs/output-format.md) — inline-comment shape, MR-level summary note, footer, and duplicate prevention.

## Configuration

The CLI auto-resolves most values from GitLab CI variables and provider-standard env vars. The two things you must provide are a model and its provider's API key:

```bash
gitlab-review --model anthropic/claude-sonnet-4-5 --api-key "$ANTHROPIC_API_KEY"
```

Equivalently, set `GITLAB_REVIEW_MODEL` and the provider's key (e.g. `ANTHROPIC_API_KEY`) as CI/CD variables. Common knobs include `--min-severity`, `--thinking`, `--posting-mode draft`, `--no-summary`, and `--dry-run`. See the full [environment-variable and flag reference](https://github.com/ikko-dev/gitlab-review/blob/main/docs/configuration.md).

## Providers

`gitlab-review` uses [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-ai) for model access. Any registered provider can be selected with `--model provider/modelId` (e.g. `anthropic/claude-sonnet-4-5`, `openrouter/anthropic/claude-3-opus-20240229`, `google/gemini-2.0-flash`, `ollama/qwen2.5-coder:32b`). See [Providers](https://github.com/ikko-dev/gitlab-review/blob/main/docs/providers.md) for per-provider setup and the model pool.

## Artifacts

- `gitlab-review.md`: raw review text returned by the agent
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

## Troubleshooting

- **`Node.js >=24 is required`**
  - Use `node:24` (or newer) in CI.
- **`Missing required configuration`**
  - Provide required flags or ensure CI vars are available (`CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, token, API key).
- **`--min-severity must be one of: info, warn, critical`**
  - Fix `--min-severity` or `GITLAB_REVIEW_MIN_SEVERITY`.
- **Git history errors / merge-base failures**
  - Set `GIT_DEPTH: 0`.
  - Ensure source and target branches are fetchable from `origin`.
- **GitLab API 401/403 when posting**
  - Ensure token has rights to read MR metadata/discussions and create MR discussions.
  - If using `CI_JOB_TOKEN`, ensure your GitLab project settings allow required API access.
- **No comments posted**
  - Check `review-comments.json` for `duplicate: true` or empty parsed comments.
  - Run with `--dry-run` and inspect `gitlab-review.md` formatting (`== Inline Comments ==`).

## Development / release

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Eval tests call the real LLM and require `ANTHROPIC_API_KEY` (or `GITLAB_REVIEW_API_KEY`) in a local `.env` file:

```bash
npm run test:evals
```

Override the model for cheaper/faster eval runs:

```bash
GITLAB_REVIEW_EVAL_MODEL=anthropic/claude-haiku-4-5-20251001 npm run test:evals
```

The review agent runs against pinned `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` versions, so published builds keep a deterministic reviewer runtime.

## Acknowledgements

`gitlab-review` builds on ideas and prior work from several projects:

- **[pi-reviewer](https://github.com/earendil-works/pi-reviewer)** — the original agent-driven code reviewer that `gitlab-review` grew out of. The agent runtime (`@earendil-works/pi-agent-core`), model abstraction (`@earendil-works/pi-ai`), and read-only coding tools (`@earendil-works/pi-coding-agent`) are all pi-reviewer infrastructure.
- **[Warden](https://warden.sentry.dev)** by Sentry — the skills architecture (per-skill instruction blocks, reference files loaded on demand by the agent, project-level discovery) takes direct inspiration from Warden's approach to composable, domain-specific review modules.
- **[agentskills.io](https://agentskills.io)** — the `SKILL.md` frontmatter format and multi-file skill layout (`references/`, `scripts/`, `assets/`) follow the agentskills.io open standard for portable agent skills.
