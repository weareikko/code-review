import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { JudgeContext } from 'vitest-evals';
// oxlint-disable eslint-plugin-jest/no-standalone-expect -- describeEval uses its own `it` wrapper that oxlint doesn't recognise
import { createHarness, createJudge, describeEval } from 'vitest-evals';
import type { Config } from '../../src/config.js';
import { runReview } from '../../src/gitlab-review.js';
import { parseReviewMarkdownWithWarnings } from '../../src/parser.js';
import type { PriorThread } from '../../src/prior-threads.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

type EvalInput = {
  diff: string;
  commitLog?: string;
  priorThreads?: PriorThread[];
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
  // Use the explicit override first, then fall back to ANTHROPIC_API_KEY for
  // backward compat, then GITLAB_REVIEW_API_KEY. For other providers (e.g.
  // openrouter), set GITLAB_REVIEW_API_KEY or the provider-specific env var.
  const apiKey =
    process.env.GITLAB_REVIEW_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    '';
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
    baseUrl: process.env.GITLAB_REVIEW_BASE_URL ?? '',
    maxTokens: Number(process.env.GITLAB_REVIEW_MAX_TOKENS ?? 0),
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
      const usage = await runReview(config, {
        diff: input.diff,
        commitLog: input.commitLog,
        priorThreads: input.priorThreads,
      });

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

// Skip evals when no API key is available. Uses || (not ??) so an empty-string
// env var correctly falls through to the next candidate.
const missingApiKey = () => {
  return !(
    process.env.GITLAB_REVIEW_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY
  );
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
  },
);

// Baseline: record judge scores without hard-failing — model may miss the bug without skill guidance.
describeEval(
  'code-review skill — bug detection (baseline, no skill)',
  {
    harness: reviewHarness,
    judges: [AsyncBugDetectedJudge, HasSevereFindingJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('async/forEach bug baseline without code-review skill', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'async-foreach-bug.diff'), 'utf8');
      const result = await run({ diff, skills: [] });

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
  },
);

// Baseline: record scores but do not hard-assert pass.
describeEval(
  'code-review skill — React stale closure detection (baseline, no skill)',
  {
    harness: reviewHarness,
    judges: [StaleClosureJudge, HasSevereFindingJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('stale closure baseline without code-review skill', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'react-stale-deps.diff'), 'utf8');
      const result = await run({ diff, skills: [] });

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
  },
);

// Baseline: record scores but do not hard-assert pass.
describeEval(
  'code-review skill — PHP race condition detection (baseline, no skill)',
  {
    harness: reviewHarness,
    judges: [RaceConditionJudge, HasSevereFindingJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('race condition baseline without code-review skill', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'php-promo-race.diff'), 'utf8');
      const result = await run({ diff, skills: [] });

      expect(result.output).toBeDefined();
    });
  },
);

// =============================================================================
// Flat diff vs patch format comparison
//
// Each case below pairs a flat merge diff with a patch-format version of the
// same change (git log --patch style: commit header + message + per-commit
// diff). The patch format is what we intend to feed the reviewer instead of
// the bare diff. These evals are all recording-only (judgeThreshold: null)
// so they never block CI — the goal is to observe whether commit-message
// context improves or degrades review quality.
//
// The "global-cache-bug" fixture is the most diagnostic: the flat diff is
// genuinely ambiguous (a module-level cache could be intentional), while the
// commit message explicitly says "keyed by userId" — making the missing key
// an obvious bug. A good outcome here is patch score > flat score.
// =============================================================================

describeEval(
  'patch format — async/forEach bug detection (recording only)',
  {
    harness: reviewHarness,
    judges: [AsyncBugDetectedJudge, HasSevereFindingJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('flat diff: detects async/forEach bug without commit context', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'async-foreach-bug.diff'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });

    it('patch format: detects async/forEach bug with commit context', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'async-foreach-bug.patch'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });
  },
);

describeEval(
  'patch format — PHP race condition detection (recording only)',
  {
    harness: reviewHarness,
    judges: [RaceConditionJudge, HasSevereFindingJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('flat diff: detects race condition without commit context', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'php-promo-race.diff'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });

    it('patch format: detects race condition with commit context ("atomically")', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'php-promo-race.patch'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });
  },
);

describeEval(
  'patch format — React stale closure detection (recording only)',
  {
    harness: reviewHarness,
    judges: [StaleClosureJudge, HasSevereFindingJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('flat diff: detects stale closure without commit context', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'react-stale-deps.diff'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });

    it('patch format: detects stale closure with commit context', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'react-stale-deps.patch'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });
  },
);

// Judge: review identifies that the cache is not keyed by userId, so it
// returns the first user's token to every subsequent caller.
const GlobalCacheBugJudge = createJudge(
  'GlobalCacheBugJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const keywords = [
      'user',
      'key',
      'keyed',
      'global',
      'shared',
      'all users',
      'module',
      'wrong user',
      'another user',
      'different user',
      'not scoped',
      'not per',
    ];
    const allText = [output.summary, ...output.comments.map((c) => c.body)].join(' ').toLowerCase();
    const hits = keywords.filter((k) => allText.includes(k));
    const score = hits.length >= 2 ? 1 : 0;
    return {
      score,
      metadata: {
        rationale:
          score === 1
            ? `Identified cross-user cache pollution (matched: ${hits.join(', ')})`
            : `Did not flag the global cache as user-specific bug (matched: ${hits.join(', ') || 'none'})`,
        commentCount: output.comments.length,
      },
    };
  },
);

// This is the most diagnostic fixture for the flat-vs-patch question:
// the flat diff alone is ambiguous (a module-level cache might be intentional),
// while the patch commit message explicitly states "keyed by userId" — making
// the missing cache key an unambiguous bug. We expect patch score > flat score.
describeEval(
  'patch format — global cache bug (commit message makes bug obvious)',
  {
    harness: reviewHarness,
    judges: [GlobalCacheBugJudge, HasSevereFindingJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('flat diff: detects cross-user cache pollution without commit context', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'global-cache-bug.diff'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });

    it('patch format: detects cross-user cache pollution — commit says "keyed by userId"', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'global-cache-bug.patch'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });
  },
);

// Judge: did the reviewer flag the empty catch / error-swallowing as a CRITICAL or WARN issue?
// With the flat diff we expect score=1 (it looks like a bug). With the patch format, if the
// model reads the commit message justification, we hope to see score=0 (not flagged as severe).
const EmptyCatchFlaggedJudge = createJudge(
  'EmptyCatchFlaggedJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const keywords = [
      'catch',
      'swallow',
      'suppress',
      'silent',
      'empty',
      'ignore',
      'unhandled',
      'error handling',
      'lost',
    ];
    const severeComments = output.comments.filter(
      (c) => c.severity === 'critical' || c.severity === 'warn',
    );
    const severeText = severeComments
      .map((c) => c.body)
      .join(' ')
      .toLowerCase();
    const flagged = keywords.some((k) => severeText.includes(k));
    return {
      score: flagged ? 1 : 0,
      metadata: {
        rationale: flagged
          ? `Reviewer raised a severe concern about the empty catch (${severeComments.length} severe comment(s))`
          : 'Reviewer did not raise a severe concern about the empty catch',
        severeComments: severeComments.map((c) => ({
          severity: c.severity,
          body: c.body.slice(0, 120),
        })),
      },
    };
  },
);

// Judge: did the reviewer surface context that can ONLY come from the commit message?
// General terms like "fire-and-forget" are known from training data and appear in flat-diff
// reviews too — they don't prove the model read the commit. We check for commit-specific
// artefacts: the ADR number, the incident reference, the SDK dead-letter detail, or the
// PagerDuty noise mention. A flat-diff reviewer cannot produce these.
// We expect score=0 for flat diff and score=1 for patch format.
const CommitContextSurfacedJudge = createJudge(
  'CommitContextSurfacedJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const commitOnlyKeywords = [
      'adr-042',
      'adr 042',
      'inc-2891',
      'inc 2891',
      'post-mortem',
      'postmortem',
      'pagerduty',
      'dead-letter',
      'dead letter',
      'non-actionable',
      'signed off',
    ];
    const allText = [output.summary, ...output.comments.map((c) => c.body)].join(' ').toLowerCase();
    const hits = commitOnlyKeywords.filter((k) => allText.includes(k));
    const score = hits.length >= 1 ? 1 : 0;
    return {
      score,
      metadata: {
        rationale:
          score === 1
            ? `Reviewer surfaced commit-specific context (matched: ${hits.join(', ')})`
            : 'Reviewer did not reference any commit-specific artefact (ADR, incident, SDK details)',
      },
    };
  },
);

// This is the core "does commit context change the review?" fixture.
// The code (empty .catch(() => {})) looks like a bug in isolation.
// The commit message explains it is an intentional architectural decision (ADR-042 / INC-2891).
//
// Expected signals:
//   flat diff           → EmptyCatchFlaggedJudge=1  (correctly flags the pattern as suspicious)
//                         CommitContextSurfacedJudge=0 (no context, can't know it's intentional)
//   <commits> section   → EmptyCatchFlaggedJudge=0  (model reads the commit and doesn't over-flag)
//                         CommitContextSurfacedJudge=1 (model surfaces the ADR/incident context)
//   patch as diff slot  → baseline comparison; model may read commit headers as diff noise
//
// If <commits> scores match flat scores, commit messages don't help on this class of change.
// If <commits> EmptyCatchFlagged < flat, the feature is genuinely useful.
describeEval(
  'commit context — intentional empty catch (commit justifies decision)',
  {
    harness: reviewHarness,
    judges: [EmptyCatchFlaggedJudge, CommitContextSurfacedJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('flat diff: reviews empty catch without commit context', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'analytics-fire-and-forget.diff'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });

    it('dedicated <commits> section: reviews empty catch with ADR-042 / INC-2891 context', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'analytics-fire-and-forget.diff'), 'utf8');
      const commitLog = await readFile(
        join(FIXTURES, 'analytics-fire-and-forget.commitlog'),
        'utf8',
      );
      const result = await run({ diff, commitLog, skills: [] });
      expect(result.output).toBeDefined();
    });

    it('patch as diff: reviews empty catch with commit header in <diff> slot (comparison baseline)', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'analytics-fire-and-forget.patch'), 'utf8');
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

// =============================================================================
// Prior review feedback — <prior_review_feedback> context
//
// Two paired scenarios that test the new feature from opposite directions:
//
// Scenario A — JUSTIFIED prior thread suppresses a false positive
//   Diff: new Express routes with no auth middleware
//   Without prior thread: reviewer correctly flags the missing auth (true positive
//     at review time, no context available)
//   With prior thread: developer explained the routes are intentionally public
//     for load-balancer health probes (specific, concrete justification)
//   Expected: reviewer stops raising auth as a severe finding and surfaces the
//     developer's explanation instead
//
// Scenario B — VAGUE prior thread does NOT suppress a concrete bug
//   Diff: null dereference on an optional field (TypeScript type says product?)
//   Without prior thread: reviewer flags the null deref
//   With prior thread: developer replied "hasn't been a problem in production"
//     (vague, no technical justification)
//   Expected: reviewer still raises the null deref as a concrete bug — vague
//     dismissals must not suppress provable defects
//
// All cases use judgeThreshold: null (recording only — LLM behaviour varies).
// =============================================================================

// Judge: does the reviewer raise a concern about missing authentication as a
// CRITICAL or WARN finding? Score=1 means the concern was raised as severe.
// For scenario A we expect this to drop from 1→0 when the prior thread explains
// the endpoint is protected at the network layer — a concrete, specific reason.
const AuthConcernRaisedJudge = createJudge(
  'AuthConcernRaisedJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const authKeywords = [
      'auth',
      'unauthenticated',
      'unauthorized',
      'authentication',
      'authorization',
      'access control',
      'permission',
    ];
    const severeComments = output.comments.filter(
      (c) => c.severity === 'critical' || c.severity === 'warn',
    );
    // Check severe comments AND summary — both carry meaningful findings.
    const severeText = [...severeComments.map((c) => c.body), output.summary]
      .join(' ')
      .toLowerCase();
    const flagged = authKeywords.some((k) => severeText.includes(k));
    return {
      score: flagged ? 1 : 0,
      metadata: {
        rationale: flagged
          ? `Reviewer raised auth as a severe concern (${severeComments.length} severe comment(s))`
          : 'Reviewer did not raise auth as a severe finding',
        severeComments: severeComments.map((c) => ({
          severity: c.severity,
          body: c.body.slice(0, 120),
        })),
      },
    };
  },
);

// Judge: did the reviewer surface the specific context from the prior thread
// reply? We require terms that can only come from the developer's explanation,
// not from the diff code itself: "vpn", "ingress", "subnet", "network layer",
// "network-level", "infrastructure level". These don't appear in the diff.
const PriorThreadContextSurfacedJudge = createJudge(
  'PriorThreadContextSurfacedJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const priorOnlyKeywords = [
      'vpn',
      'ingress',
      'subnet',
      'network layer',
      'network-level',
      'infrastructure level',
      '10.',
      'internal network',
    ];
    const allText = [output.summary, ...output.comments.map((c) => c.body)].join(' ').toLowerCase();
    const hits = priorOnlyKeywords.filter((k) => allText.includes(k));
    const score = hits.length >= 1 ? 1 : 0;
    return {
      score,
      metadata: {
        rationale:
          score === 1
            ? `Reviewer surfaced prior thread context (matched: ${hits.join(', ')})`
            : 'Reviewer did not reference network-layer justification from the prior thread',
      },
    };
  },
);

// The fixture is /admin/config + /admin/features/:flag — routes that expose
// environment variables, DB/Redis hosts, integration URLs, and allow toggling
// feature flags, all without any authentication middleware. The model reliably
// flags this as a severe auth issue when no context is provided. The prior
// thread explains the routes are guarded at the network layer (VPN + ingress
// controller subnet restriction), not the application layer.
describeEval(
  'prior review feedback — justified explanation suppresses false positive',
  {
    harness: reviewHarness,
    judges: [AuthConcernRaisedJudge, PriorThreadContextSurfacedJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('no prior thread: reviewer flags unauthenticated admin routes as a concern', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'admin-config-endpoint.diff'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });

    it('with prior thread: reviewer acknowledges network-layer protection and does not re-raise', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'admin-config-endpoint.diff'), 'utf8');
      const priorThreads: PriorThread[] = [
        {
          file: 'src/routes/admin.ts',
          line: 8,
          resolved: false,
          botComment:
            '/admin/config exposes environment variables, database hosts, and integration URLs without any authentication middleware. Any unauthenticated caller with network access can read this data or toggle feature flags via /admin/features/:flag.',
          replies: [
            'These routes are only reachable from inside our private VPN. The ingress controller restricts access to the 10.32.0.0/14 subnet — requests from the public internet never reach the application layer. Application-level auth would be redundant here and adds latency to internal tooling.',
          ],
        },
      ];
      const result = await run({ diff, priorThreads, skills: [] });
      expect(result.output).toBeDefined();
    });
  },
);

// Judge: does the reviewer raise the null-dereference as a CRITICAL or WARN
// finding? Score=1 means it was correctly flagged as a concrete defect.
// For scenario B we expect this to stay at 1 even when the developer gave a
// vague "hasn't been a problem" dismissal — that is not a technical justification.
const NullDereferenceFlaggedJudge = createJudge(
  'NullDereferenceFlaggedJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const keywords = ['null', 'undefined', 'optional', 'product?', 'typeerror', 'dereference'];
    const severeComments = output.comments.filter(
      (c) => c.severity === 'critical' || c.severity === 'warn',
    );
    const severeText = severeComments
      .map((c) => c.body)
      .join(' ')
      .toLowerCase();
    const summaryText = output.summary.toLowerCase();
    const flagged = keywords.some((k) => severeText.includes(k) || summaryText.includes(k));
    return {
      score: flagged ? 1 : 0,
      metadata: {
        rationale: flagged
          ? `Reviewer correctly flagged the null/undefined dereference (${severeComments.length} severe comment(s))`
          : 'Reviewer did not flag the null dereference — possible false negative',
        severeComments: severeComments.map((c) => ({
          severity: c.severity,
          body: c.body.slice(0, 120),
        })),
      },
    };
  },
);

describeEval(
  'prior review feedback — vague dismissal does not suppress a concrete bug',
  {
    harness: reviewHarness,
    judges: [NullDereferenceFlaggedJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('no prior thread: reviewer flags the null dereference', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'null-deref-vague-dismissal.diff'), 'utf8');
      const result = await run({ diff, skills: [] });
      expect(result.output).toBeDefined();
    });

    it('with vague prior thread reply: reviewer still flags the null dereference', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'null-deref-vague-dismissal.diff'), 'utf8');
      const priorThreads: PriorThread[] = [
        {
          file: 'src/billing/invoice.ts',
          line: 14,
          resolved: false,
          botComment:
            'item.product is declared as optional (Product | undefined). Accessing item.product.name and item.product.unitPrice without a null check will throw a TypeError at runtime when product is undefined.',
          replies: ["We've never seen this throw in production."],
        },
      ];
      const result = await run({ diff, priorThreads, skills: [] });
      expect(result.output).toBeDefined();
    });
  },
);
