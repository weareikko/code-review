import type { JudgeContext } from 'vitest-evals';

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
// oxlint-disable eslint-plugin-jest/no-standalone-expect -- describeEval uses its own `it` wrapper that oxlint doesn't recognise
import { createHarness, createJudge, describeEval } from 'vitest-evals';

import type { Config } from '../../src/config.js';

import { runReview } from '../../src/gitlab-review.js';
import { parseReviewMarkdownWithWarnings } from '../../src/parser.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

type EvalInput = {
  diff: string;
  skills: string[];
};

type ReviewComment = {
  file: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  severity: 'critical' | 'warn' | 'info';
  body: string;
};

type EvalOutput = {
  summary: string;
  comments: ReviewComment[];
};

function makeConfig(overrides: Partial<Config>): Config {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.GITLAB_REVIEW_API_KEY ?? '';
  return {
    project: 'test',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'test',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: process.env.GITLAB_REVIEW_EVAL_MODEL ?? 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    apiKey,
    reviewFile: 'gitlab-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: true,
    postSummary: false,
    forceReview: false,
    cwd: process.cwd(),
    skills: [],
    ...overrides,
  };
}

const reviewHarness = createHarness<EvalInput, EvalOutput, Record<string, unknown>>({
  name: 'gitlab-review',
  run: async ({ input }) => {
    const dir = await mkdtemp(join(tmpdir(), 'gitlab-review-eval-'));
    try {
      const config = makeConfig({ cwd: dir, skills: input.skills });
      const usage = await runReview(config, { diff: input.diff });

      const reviewPath = join(dir, config.reviewFile);
      const raw = await readFile(reviewPath, 'utf8');
      const parsed = parseReviewMarkdownWithWarnings(raw);
      const output: EvalOutput = {
        summary: parsed.summary ?? '',
        comments: parsed.comments.map((c) => ({
          file: c.file,
          line: c.line,
          side: c.side,
          severity: c.severity,
          body: c.body,
        })),
      };

      return {
        output,
        usage: {
          provider: 'anthropic',
          model: usage.model,
          inputTokens: usage.tokens.input,
          outputTokens: usage.tokens.output,
          totalTokens: usage.tokens.total,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});

// Judge: review mentions the async/forEach pattern (any comment or summary body)
const AsyncBugDetectedJudge = createJudge(
  'AsyncBugDetectedJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const patterns = [
      'foreach',
      'fire-and-forget',
      'not awaited',
      'unhandled',
      'promise',
      'swallowed',
      'never resolves',
      'never await',
      "won't be awaited",
    ];
    const allText = [output.summary, ...output.comments.map((c) => c.body)].join(' ').toLowerCase();
    const hit = patterns.some((p) => allText.includes(p));
    return {
      score: hit ? 1 : 0,
      metadata: {
        rationale: hit
          ? 'Review correctly mentions the async/forEach bug'
          : 'Review did not identify the async/forEach issue',
        commentCount: output.comments.length,
      },
    };
  },
);

// Judge: the review has at least one CRITICAL or WARN finding
const HasSevereFindingJudge = createJudge(
  'HasSevereFindingJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const severe = output.comments.filter(
      (c) => c.severity === 'critical' || c.severity === 'warn',
    );
    return {
      score: severe.length > 0 ? 1 : 0,
      metadata: {
        rationale:
          severe.length > 0
            ? `Found ${severe.length} severe finding(s)`
            : 'No CRITICAL or WARN comments produced',
        severeComments: severe.map((c) => ({ file: c.file, severity: c.severity })),
      },
    };
  },
);

// Judge: clean diffs produce no severe findings (CRITICAL or WARN comments)
const NoSevereFindingsJudge = createJudge(
  'NoSevereFindingsJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const severe = output.comments.filter(
      (c) => c.severity === 'critical' || c.severity === 'warn',
    );
    return {
      score: severe.length === 0 ? 1 : 0,
      metadata: {
        rationale:
          severe.length === 0
            ? 'No false positives on clean code'
            : `Produced ${severe.length} severe finding(s) on clean code (possible false positives)`,
        severeComments: severe.map((c) => ({
          file: c.file,
          severity: c.severity,
          body: c.body.slice(0, 120),
        })),
      },
    };
  },
);

const missingApiKey = () => {
  return !(process.env.ANTHROPIC_API_KEY ?? process.env.GITLAB_REVIEW_API_KEY);
};

describeEval(
  'code-review skill — bug detection',
  {
    harness: reviewHarness,
    judges: [AsyncBugDetectedJudge, HasSevereFindingJudge],
    judgeThreshold: 1,
    skipIf: missingApiKey,
  },
  (it) => {
    it('detects async/forEach bugs with code-review skill enabled', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'async-foreach-bug.diff'), 'utf8');
      const result = await run({ diff, skills: ['code-review'] });

      const asyncComments = result.output.comments.filter((c) =>
        c.body.toLowerCase().includes('foreach'),
      );
      // At minimum the summary should call out the async bug
      const allText = [result.output.summary, ...result.output.comments.map((c) => c.body)]
        .join(' ')
        .toLowerCase();
      const mentionedAsync = asyncComments.length > 0 || allText.includes('async');

      expect(mentionedAsync).toBe(true);
      expect(result.output.comments.length).toBeGreaterThan(0);
    });

    it('detects async/forEach bugs without code-review skill (baseline)', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'async-foreach-bug.diff'), 'utf8');
      const result = await run({ diff, skills: [] });

      // Record baseline scores without requiring pass — judges still run
      expect(result.output).toBeDefined();
      expect(result.output.summary).toBeTruthy();
    });
  },
);

// Judge: review identifies the missing deps / stale closure in useEffect
const StaleClosureJudge = createJudge(
  'StaleClosureJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const keywords = [
      'stale',
      'closure',
      'dependency',
      'dependencies',
      'dep',
      'useeffect',
      'missing',
      'debounce',
      'initial',
    ];
    const allText = [output.summary, ...output.comments.map((c) => c.body)].join(' ').toLowerCase();
    const hit = keywords.filter((k) => allText.includes(k));
    // Require at least 2 distinct keywords to avoid accidental matches
    const score = hit.length >= 2 ? 1 : 0;
    return {
      score,
      metadata: {
        rationale:
          score === 1
            ? `Detected stale closure/missing dep issue (matched: ${hit.join(', ')})`
            : `Did not identify stale closure — only matched: ${hit.join(', ') || 'none'}`,
        commentCount: output.comments.length,
      },
    };
  },
);

// Judge: review identifies the race condition in the PHP promo code handler
const RaceConditionJudge = createJudge(
  'RaceConditionJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const keywords = ['race', 'concurrent', 'atomic', 'lock', 'transaction', 'updateorcreate'];
    const allText = [output.summary, ...output.comments.map((c) => c.body)].join(' ').toLowerCase();
    const hit = keywords.filter((k) => allText.includes(k));
    const score = hit.length >= 1 ? 1 : 0;
    return {
      score,
      metadata: {
        rationale:
          score === 1
            ? `Detected race condition issue (matched: ${hit.join(', ')})`
            : 'Did not identify the race condition or non-atomic update',
        commentCount: output.comments.length,
      },
    };
  },
);

describeEval(
  'code-review skill — React stale closure detection',
  {
    harness: reviewHarness,
    judges: [StaleClosureJudge, HasSevereFindingJudge],
    judgeThreshold: 1,
    skipIf: missingApiKey,
  },
  (it) => {
    it('detects missing useEffect deps / stale closure with skill', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'react-stale-deps.diff'), 'utf8');
      const result = await run({ diff, skills: ['code-review'] });

      expect(result.output.comments.length).toBeGreaterThan(0);
    });

    it('detects missing useEffect deps / stale closure without skill (baseline)', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'react-stale-deps.diff'), 'utf8');
      const result = await run({ diff, skills: [] });

      // Baseline: record scores but do not hard-assert pass
      expect(result.output).toBeDefined();
    });
  },
);

describeEval(
  'code-review skill — PHP race condition detection',
  {
    harness: reviewHarness,
    judges: [RaceConditionJudge, HasSevereFindingJudge],
    judgeThreshold: 1,
    skipIf: missingApiKey,
  },
  (it) => {
    it('detects non-atomic promo code claim with skill', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'php-promo-race.diff'), 'utf8');
      const result = await run({ diff, skills: ['code-review'] });

      expect(result.output.comments.length).toBeGreaterThan(0);
    });

    it('detects non-atomic promo code claim without skill (baseline)', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'php-promo-race.diff'), 'utf8');
      const result = await run({ diff, skills: [] });

      expect(result.output).toBeDefined();
    });
  },
);

describeEval(
  'code-review skill — false positive rate',
  {
    harness: reviewHarness,
    judges: [NoSevereFindingsJudge],
    // Use null so false positives are recorded without hard-failing CI (LLM non-determinism)
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('produces no severe findings on clean code with skill enabled', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'clean-ts.diff'), 'utf8');
      const result = await run({ diff, skills: ['code-review'] });

      const severe = result.output.comments.filter(
        (c) => c.severity === 'CRITICAL' || c.severity === 'WARN',
      );
      // Soft assertion — recorded but not a hard test failure
      if (severe.length > 0) {
        console.warn(
          '[eval] code-review skill produced unexpected severe findings on clean code:',
          severe.map((c) => `${c.severity} ${c.file}:${c.line}`).join(', '),
        );
      }

      expect(result.output).toBeDefined();
    });

    it('produces no severe findings on clean code without skill (baseline)', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'clean-ts.diff'), 'utf8');
      const result = await run({ diff, skills: [] });

      expect(result.output).toBeDefined();
    });
  },
);
