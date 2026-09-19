# Jev vs agentic Verify — SWE-PRBench (real findings)

- Find model: `openrouter/openai/gpt-5.6-luna` (depth single, thinking medium), Find cost $1.1795
- Jev model: `typesafe/jev-1.13` via OpenRouter `/api/alpha/decisions`
- PRs: 16 × 4 trial(s) · findings: 41 · severe (verified): 41
- Gold labels on severe: CONFIRMED 18 · PLAUSIBLE 18 (excluded) · FABRICATED 4

## Accuracy against gold

| arm     | keeps CONFIRMED | drops FABRICATED | overall |
| ------- | --------------- | ---------------- | ------- |
| Jev     | 17/18 (94%)     | 0/4 (0%)         | 77%     |
| agentic | 11/18 (61%)     | 0/4 (0%)         | 50%     |

## Cost and latency (Verify stage only)

- Jev: $0.005799 total, median 305ms
- agentic: median 2625ms
- agreement between arms: 29/41 (71%)

## Confidence threshold — how much Jev could decide alone

| min confidence | findings covered | share of severe | accuracy on covered |
| -------------- | ---------------- | --------------- | ------------------- |
| 0.5            | 6                | 15%             | 5/6 (83%)           |
| 0.6            | 4                | 10%             | 3/4 (75%)           |
| 0.7            | 3                | 7%              | 3/3 (100%)          |
| 0.8            | 1                | 2%              | 1/1 (100%)          |
| 0.9            | 0                | 0%              | 0/0 (n/a)           |

## Disagreements

| task                  | trial | file:line                                                     | sev  | gold      | jev       | conf | demo | agentic |
| --------------------- | ----- | ------------------------------------------------------------- | ---- | --------- | --------- | ---- | ---- | ------- |
| effect\_\_5952        | 0     | packages/opentelemetry/package.json:65                        | warn | PLAUSIBLE | keep      | 0.30 | 0.63 | drop    |
| stylelint\_\_9044     | 2     | lib/rules/keyframe-selector-notation/index.mjs:37             | warn | PLAUSIBLE | drop      | 0.24 | 0.37 | keep    |
| node-postgres\_\_3547 | 0     | packages/pg/lib/connection-parameters.js:9                    | warn | CONFIRMED | keep      | 0.71 | 0.80 | drop    |
| node-postgres\_\_3547 | 1     | packages/pg/lib/connection-parameters.js:10                   | warn | CONFIRMED | keep      | 0.71 | 0.73 | drop    |
| node-postgres\_\_3547 | 3     | packages/pg/lib/index.js:41                                   | warn | CONFIRMED | keep      | 0.58 | 0.85 | drop    |
| node-postgres\_\_3547 | 3     | packages/pg/lib/connection-parameters.js:8                    | warn | CONFIRMED | keep      | 0.88 | 0.62 | drop    |
| stylelint\_\_9062     | 2     | lib/rules/declaration-property-value-no-unknown/index.mjs:147 | warn | PLAUSIBLE | drop      | 0.06 | 0.28 | keep    |
| vitest\_\_9152        | 3     | packages/vitest/src/node/test-run.ts:327                      | warn | PLAUSIBLE | keep      | 0.32 | 0.52 | drop    |
| vitest\_\_9521        | 1     | packages/vitest/src/node/coverage.ts:336                      | warn | PLAUSIBLE | downgrade | 0.17 | 0.45 | drop    |
| zod\_\_5672           | 0     | packages/zod/src/v4/core/schemas.ts:483                       | warn | PLAUSIBLE | keep      | 0.40 | 0.68 | drop    |
| zod\_\_5672           | 2     | packages/zod/src/v4/core/schemas.ts:483                       | warn | CONFIRMED | keep      | 0.26 | 0.62 | drop    |
| zod\_\_5672           | 3     | packages/zod/src/v4/core/schemas.ts:483                       | warn | CONFIRMED | keep      | 0.04 | 0.60 | drop    |
