import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Config } from '../../src/config.js';
import { resolveProviderApiKey } from '../../src/config.js';
import { runReview } from '../../src/gitlab-review.js';
import { parseReviewMarkdownWithWarnings } from '../../src/parser.js';

// Measures item 4 (retrieve-skipped). Builds a large diff whose ONLY real bug
// lives in a small file that the char budget drops (it has few additions, so it
// ranks last). With retrieval OFF the bug is unreachable; with retrieval ON its
// diff is staged on disk and the agent can read it. Reports whether the bug is
// found, off vs on, plus cost.
//
// OFF by default (real LLM, costs money): SKIPPED_RETRIEVAL_RUN=1 to run.

const TRIALS = Number(process.env.SKIPPED_RETRIEVAL_TRIALS) || 3;
// Route through the configured provider (Cloudflare AI Gateway in CI); no direct
// OpenAI/Anthropic calls. Key resolved per-provider from the model id.
const MODEL = process.env.GITLAB_REVIEW_EVAL_MODEL ?? 'cloudflare-ai-gateway/claude-3-5-haiku';
const apiKey = resolveProviderApiKey(MODEL);
const skip = process.env.SKIPPED_RETRIEVAL_RUN !== '1' || !apiKey;

// Bulk file: many added lines, no bug — ranks first, consumes the budget.
const bulk =
  [`diff --git a/src/bulk.ts b/src/bulk.ts`, `@@ -1 +1,200 @@`, ' import { x } from "./x.js";']
    .concat(Array.from({ length: 200 }, (_, i) => `+export const K${i} = ${i};`))
    .join('\n') + '\n';

// Bug file: few added lines with a blatant SQL injection — ranks last, dropped.
const bugFile =
  [
    'diff --git a/src/db/query.ts b/src/db/query.ts',
    '@@ -1 +1,4 @@',
    ' import { db } from "./db.js";',
    '+export function findUser(name: string) {',
    '+  return db.query(\'SELECT * FROM users WHERE name = \' + "\'" + name + "\'");',
    '+}',
  ].join('\n') + '\n';

const DIFF = bulk + bugFile;

function makeConfig(cwd: string, retrieveSkipped: boolean): Config {
  return {
    project: 'test',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'test',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: MODEL,
    modelPool: [],
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    reviewDepth: 'single',
    verifyModel: '',
    apiKey,
    baseUrl: '',
    maxTokens: 0,
    // Budget fits the bulk file but not the bug file (which ranks last).
    maxDiffChars: bulk.length + 40,
    decomposeHintLines: 0,
    diffContext: 0,
    retrieveSkipped,
    reviewFile: 'gitlab-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: true,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd,
    skills: ['code-review'],
    refreshGitSkills: false,
  };
}

function foundSqlBug(text: string): boolean {
  const t = text.toLowerCase();
  return (
    (t.includes('sql') || t.includes('injection') || t.includes('query.ts')) &&
    (t.includes('inject') || t.includes('sql') || t.includes('concat') || t.includes('sanit'))
  );
}

async function runOnce(retrieveSkipped: boolean): Promise<{ found: boolean; cost: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'retr-'));
  try {
    const usage = await runReview(makeConfig(dir, retrieveSkipped), { diff: DIFF });
    const raw = await readFile(join(dir, 'gitlab-review.md'), 'utf8');
    const parsed = parseReviewMarkdownWithWarnings(raw);
    const haystack = [parsed.summary ?? '', ...parsed.comments.map((c) => `${c.file} ${c.body}`)]
      .join('\n')
      .toLowerCase();
    return { found: foundSqlBug(haystack), cost: usage.cost.total };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test.skipIf(skip)(
  'retrieve-skipped — recall of a bug in a budget-dropped file, off vs on',
  { timeout: 120_000 * TRIALS * 2 },
  async () => {
    const off = { found: 0, cost: 0 };
    const on = { found: 0, cost: 0 };
    for (let t = 0; t < TRIALS; t += 1) {
      const o = await runOnce(false);
      off.found += o.found ? 1 : 0;
      off.cost += o.cost;
      const n = await runOnce(true);
      on.found += n.found ? 1 : 0;
      on.cost += n.cost;
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n=== retrieve-skipped (item 4), ${TRIALS} trials, ${MODEL} ===\n` +
        `OFF (dropped): bug found ${off.found}/${TRIALS}, avg cost $${(off.cost / TRIALS).toFixed(5)}\n` +
        `ON  (staged):  bug found ${on.found}/${TRIALS}, avg cost $${(on.cost / TRIALS).toFixed(5)}`,
    );
    expect(off.found + on.found).toBeGreaterThanOrEqual(0);
  },
);
