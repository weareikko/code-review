# Jev vs agentic Verify — SWE-PRBench (real findings)

- Find model: `openrouter/openai/gpt-5.6-luna` (depth single, thinking medium), Find cost $1.1795
- Jev model: `typesafe/jev-1.13` via OpenRouter `/api/alpha/decisions`
- PRs: 16 × 4 trial(s) · findings: 41 · severe (verified): 41
- Correctness judge: `openrouter/anthropic/claude-sonnet-5` × 2 samples (unanimous only), cost $7.1212
- Scored: 39/41 — should keep 37 · should drop 2
- Unsettled: 2 (2 split votes, rest UNPROVABLE) · claims about pre-existing behaviour: 2

## Accuracy against the correctness judge

| arm     | keeps true findings | drops false/pre-existing | overall |
| ------- | ------------------- | ------------------------ | ------- |
| Jev     | 35/37 (95%)         | 0/2 (0%)                 | 90%     |
| agentic | 26/37 (70%)         | 1/2 (50%)                | 69%     |

## Cost and latency (Verify stage only)

- Jev: $0.005799 total, median 305ms
- agentic: median 2625ms
- agreement between arms: 29/41 (71%)

## Gold-comment label vs claim-level truth

Why `matchAndVerdict` cannot score a verifier: its verdict answers "does this
match a human comment", not "is this claim true".

| matchAndVerdict said | judge: should keep | judge: should drop |
| -------------------- | ------------------ | ------------------ |
| CONFIRMED            | 17                 | 1                  |
| PLAUSIBLE            | 15                 | 1                  |
| FABRICATED           | 4                  | 0                  |

## Confidence threshold — how much Jev could decide alone

| min confidence | findings covered | share of severe | accuracy on covered |
| -------------- | ---------------- | --------------- | ------------------- |
| 0.5            | 8                | 20%             | 7/8 (88%)           |
| 0.6            | 4                | 10%             | 3/4 (75%)           |
| 0.7            | 3                | 7%              | 2/3 (67%)           |
| 0.8            | 1                | 2%              | 1/1 (100%)          |
| 0.9            | 0                | 0%              | 0/0 (n/a)           |

## Disagreements

| task                  | trial | file:line                                                     | sev  | expected | gold      | jev       | conf | agentic |
| --------------------- | ----- | ------------------------------------------------------------- | ---- | -------- | --------- | --------- | ---- | ------- |
| effect\_\_5952        | 0     | packages/opentelemetry/package.json:65                        | warn | keep     | PLAUSIBLE | keep      | 0.30 | drop    |
| stylelint\_\_9044     | 2     | lib/rules/keyframe-selector-notation/index.mjs:37             | warn | -        | PLAUSIBLE | drop      | 0.24 | keep    |
| node-postgres\_\_3547 | 0     | packages/pg/lib/connection-parameters.js:9                    | warn | keep     | CONFIRMED | keep      | 0.71 | drop    |
| node-postgres\_\_3547 | 1     | packages/pg/lib/connection-parameters.js:10                   | warn | drop     | CONFIRMED | keep      | 0.71 | drop    |
| node-postgres\_\_3547 | 3     | packages/pg/lib/index.js:41                                   | warn | keep     | CONFIRMED | keep      | 0.58 | drop    |
| node-postgres\_\_3547 | 3     | packages/pg/lib/connection-parameters.js:8                    | warn | keep     | CONFIRMED | keep      | 0.88 | drop    |
| stylelint\_\_9062     | 2     | lib/rules/declaration-property-value-no-unknown/index.mjs:147 | warn | -        | PLAUSIBLE | drop      | 0.06 | keep    |
| vitest\_\_9152        | 3     | packages/vitest/src/node/test-run.ts:327                      | warn | keep     | PLAUSIBLE | keep      | 0.32 | drop    |
| vitest\_\_9521        | 1     | packages/vitest/src/node/coverage.ts:336                      | warn | keep     | PLAUSIBLE | downgrade | 0.17 | drop    |
| zod\_\_5672           | 0     | packages/zod/src/v4/core/schemas.ts:483                       | warn | keep     | PLAUSIBLE | keep      | 0.40 | drop    |
| zod\_\_5672           | 2     | packages/zod/src/v4/core/schemas.ts:483                       | warn | keep     | CONFIRMED | keep      | 0.26 | drop    |
| zod\_\_5672           | 3     | packages/zod/src/v4/core/schemas.ts:483                       | warn | keep     | CONFIRMED | keep      | 0.04 | drop    |
