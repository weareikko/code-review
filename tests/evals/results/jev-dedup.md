# Jev vs Jaccard — Triage dedup

- Pairs: 36 (32 duplicates, 4 distinct), hand-labelled
- Every pair already passes Triage's file + MAX_LINE_DELTA gate; only subject similarity is under test
- Jev: `typesafe/jev-1.13`, threshold 0.5, cost $0.000892, median 316ms

## Detection

A false merge silently deletes a real finding, so precision matters more than recall.
| method | recall on duplicates | precision | false merges | missed duplicates |
| --- | --- | --- | --- | --- |
| Jaccard ≥ 0.6 (current) | 2/32 (6%) | 100% | 0 | 30 |
| Jev ≥ 0.5 | 32/32 (100%) | 100% | 0 | 0 |

## Jev threshold sweep

| threshold | recall | precision | false merges |
| --------- | ------ | --------- | ------------ |
| 0.3       | 100%   | 94%       | 2            |
| 0.4       | 100%   | 94%       | 2            |
| 0.5       | 100%   | 100%      | 0            |
| 0.6       | 100%   | 100%      | 0            |
| 0.7       | 100%   | 100%      | 0            |
| 0.8       | 100%   | 100%      | 0            |
| 0.9       | 97%    | 100%      | 0            |

## Per-pair

| task                  | file:lines                    | labelled  | jaccard  | jev p | agree? |
| --------------------- | ----------------------------- | --------- | -------- | ----- | ------ |
| effect\_\_5952        | package.json:65/65            | duplicate | separate | 0.97  | ✓      |
| effect\_\_5952        | package.json:65/67            | duplicate | separate | 0.98  | ✓      |
| effect\_\_5952        | package.json:65/67            | duplicate | separate | 0.98  | ✓      |
| effect\_\_5952        | package.json:67/68            | duplicate | separate | 0.98  | ✓      |
| node-postgres\_\_3547 | connection-parameters.js:8/8  | distinct  | separate | 0.48  | ✓      |
| node-postgres\_\_3547 | connection-parameters.js:8/10 | distinct  | separate | 0.41  | ✓      |
| node-postgres\_\_3547 | connection-parameters.js:9/8  | duplicate | separate | 0.97  | ✓      |
| node-postgres\_\_3547 | connection-parameters.js:9/8  | distinct  | separate | 0.27  | ✓      |
| node-postgres\_\_3547 | connection-parameters.js:9/10 | duplicate | separate | 0.98  | ✓      |
| node-postgres\_\_3547 | connection-parameters.js:10/8 | duplicate | separate | 0.96  | ✓      |
| stylelint\_\_9044     | index.mjs:52/52               | duplicate | separate | 0.92  | ✓      |
| stylelint\_\_9044     | index.mjs:52/52               | duplicate | separate | 0.95  | ✓      |
| stylelint\_\_9044     | index.mjs:52/52               | duplicate | separate | 0.96  | ✓      |
| stylelint\_\_9044     | index.mjs:52/52               | duplicate | separate | 0.90  | ✓      |
| stylelint\_\_9044     | index.mjs:52/52               | duplicate | separate | 0.95  | ✓      |
| stylelint\_\_9044     | index.mjs:52/52               | duplicate | merge    | 0.95  | ✓      |
| stylelint\_\_9044     | index.mjs:35/37               | duplicate | separate | 0.96  | ✓      |
| stylelint\_\_9074     | regexes.mjs:36/38             | duplicate | merge    | 0.93  | ✓      |
| vega\_\_4219          | transform.ts:46/46            | duplicate | separate | 0.98  | ✓      |
| vega\_\_4219          | transform.ts:46/46            | duplicate | separate | 0.97  | ✓      |
| vega\_\_4219          | transform.ts:46/46            | duplicate | separate | 0.97  | ✓      |
| vega\_\_4219          | transform.ts:46/46            | duplicate | separate | 0.97  | ✓      |
| vega\_\_4219          | transform.ts:46/46            | duplicate | separate | 0.98  | ✓      |
| vega\_\_4219          | transform.ts:46/46            | duplicate | separate | 0.97  | ✓      |
| vitest\_\_9521        | coverage.ts:338/336           | distinct  | separate | 0.22  | ✓      |
| vitest\_\_9521        | coverage.ts:338/340           | duplicate | separate | 0.94  | ✓      |
| vitest\_\_9521        | coverage.ts:340/341           | duplicate | separate | 0.97  | ✓      |
| zod\_\_5578           | to-json-schema.ts:431/431     | duplicate | separate | 0.97  | ✓      |
| zod\_\_5578           | to-json-schema.ts:431/431     | duplicate | separate | 0.95  | ✓      |
| zod\_\_5578           | to-json-schema.ts:431/431     | duplicate | separate | 0.87  | ✓      |
| zod\_\_5672           | schemas.ts:483/483            | duplicate | separate | 0.98  | ✓      |
| zod\_\_5672           | schemas.ts:483/483            | duplicate | separate | 0.97  | ✓      |
| zod\_\_5672           | schemas.ts:483/483            | duplicate | separate | 0.98  | ✓      |
| zod\_\_5672           | schemas.ts:483/483            | duplicate | separate | 0.98  | ✓      |
| zod\_\_5672           | schemas.ts:483/483            | duplicate | separate | 0.97  | ✓      |
| zod\_\_5672           | schemas.ts:483/483            | duplicate | separate | 0.98  | ✓      |
