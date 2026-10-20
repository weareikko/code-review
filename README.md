# code-review

Agent-driven code review for **GitLab merge requests and GitHub pull requests**, as an npm CLI and a GitHub Action, and the context, skills and MCP configuration that the weareikko agents share.

This repository is an npm workspaces monorepo:

| Package                                                | npm                                                                                                                                                                | What it is                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@weareikko/code-review`](./packages/code-review)     | [![npm](https://img.shields.io/npm/v/@weareikko/code-review.svg?style=flat&colorB=3e63dd&colorA=414853)](https://www.npmjs.com/package/@weareikko/code-review)     | The review CLI and library: it runs the reviewer agent, posts deduplicated inline comments and upserts a summary. [Documentation](./packages/code-review/README.md)     |
| [`@weareikko/agent-context`](./packages/agent-context) | [![npm](https://img.shields.io/npm/v/@weareikko/agent-context.svg?style=flat&colorB=3e63dd&colorA=414853)](https://www.npmjs.com/package/@weareikko/agent-context) | Convention files, skills, marketplaces and MCP server configuration, shared by code-review and code-implementation. [Documentation](./packages/agent-context/README.md) |

Both packages share one version and are released together.

## GitHub Action

The composite action at the root of this repository ([`action.yml`](./action.yml)) runs `@weareikko/code-review` on a pull request:

```yml
name: code-review
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: weareikko/code-review@0 # or a minor tag such as @0.11, or an exact version
        with:
          model: anthropic/claude-sonnet-4-5
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The [reusable workflow](./.github/workflows/code-review.yml), the GitLab CI setup, the inputs and the pinning rules are in the [code-review documentation](./packages/code-review/README.md#github-actions-example).

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[FSL-1.1-ALv2](./LICENSE)
