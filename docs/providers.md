# Providers

← Back to the [README](../README.md)

`code-review` uses [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-ai) for model
access. Any registered provider can be selected with `--model provider/modelId`.

## Anthropic

```bash
ANTHROPIC_API_KEY=sk-ant-... npx @weareikko/code-review --model anthropic/claude-sonnet-4-5
```

## OpenRouter

Multi-slash model IDs are supported — the provider is taken from the first segment only:

```bash
OPENROUTER_API_KEY=sk-or-... npx @weareikko/code-review \
  --model openrouter/anthropic/claude-3-opus-20240229
```

## Google Gemini

```bash
GEMINI_API_KEY=... npx @weareikko/code-review --model google/gemini-2.0-flash
```

## Ollama (local)

Point `OLLAMA_HOST` at your Ollama server. No API key is required:

```bash
OLLAMA_HOST=http://localhost:11434 \
CODE_REVIEW_MODEL=ollama/qwen2.5-coder:32b \
npx @weareikko/code-review
```

`OLLAMA_HOST` defaults to `http://localhost:11434` when not set. Use `CODE_REVIEW_MAX_TOKENS`
to override the maximum output tokens when Ollama returns fewer tokens than expected.

## Generic OpenAI-compatible endpoint

Use `CODE_REVIEW_BASE_URL` to point the provider at any OpenAI-compatible API:

```bash
OPENAI_API_KEY=my-key \
CODE_REVIEW_BASE_URL=https://my-gateway.example.com/v1 \
npx @weareikko/code-review --model openai/gpt-4o
```

## Heterogeneous review with a model pool

`full`-depth review (`--review-depth full`) runs several finders in parallel (one per angle) and then re-checks each severe finding with an adversarial verifier. Most of the value of a multi-agent review comes from _model_ diversity, not just prompt diversity: running every agent on the same model is one reviewer with a larger invoice, and an adversarial verifier sharing the finder's model shares its blind spots.

Pass a comma-separated pool of `provider/modelId` models to spread the pipeline across distinct models:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
GEMINI_API_KEY=... \
npx @weareikko/code-review \
  --review-depth full \
  --model anthropic/claude-sonnet-4-5 \
  --model-pool anthropic/claude-sonnet-4-5,google/gemini-2.5-pro
```

Behaviour:

- **Fixed angle→model mapping.** Angle `i` runs on pool member `i % pool.length`. The mapping is deterministic and stable for a given (MR/PR, commit) — there is no randomness or round-robin.
- **Cross-family verifier.** Each severe finding is verified by a pool member _other than_ the model that authored it (with 3+ members the tie-break is deterministic by pool order; with a single-model pool it degenerates to today's behaviour). The author-model annotation is internal pipeline metadata only — it never reaches a posted comment, fingerprint, or the summary.
- **Per-stage key resolution.** Each member resolves its own provider key from that provider's standard env var, so a key for one provider is never sent to another. A member whose key is missing or empty is dropped with a warning instead of failing the run; if every member is unusable, the pipeline falls back to `--model` (which is already validated to have a key).
- **Per-model cost breakdown.** When more than one distinct model runs, the `Review usage:` output adds a per-model breakdown (tokens and cost per pool member) and `review-usage.json` records the same under a `byModel` array. The top-level totals are the sum across the pool.
- **Hardened de-duplication.** Because heterogeneous models phrase the same finding differently and may anchor it a line or two apart, Triage merges findings that share a file, sit within a few lines of each other, and have a sufficiently similar subject — while still refusing to over-merge genuinely distinct findings on adjacent lines. The merge is deterministic and order-independent regardless of the order angles complete in.

An empty pool (the default) means the effective pool is just `[--model]`, which reproduces single-model behaviour byte-for-byte. The pool is only consulted by `full` depth; `single` and `verify` always run on `--model`.

The staged pipeline behind `--review-depth` (Find / Verify / Synthesize) is described in detail in [multi-stage-review.md](./multi-stage-review.md).
