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
import { createLlmJudge } from './llm-judge.js';
import type { Trajectory } from './trajectory.js';
import { createTrajectoryCollector } from './trajectory.js';

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
  confidence: 'high' | 'medium' | 'low';
  body: string;
};

type EvalOutput = {
  summary: string;
  comments: ReviewComment[];
  trajectory: Trajectory;
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
      const { trajectory, attach } = createTrajectoryCollector();
      const usage = await runReview(config, {
        diff: input.diff,
        commitLog: input.commitLog,
        priorThreads: input.priorThreads,
        attachTelemetry: (agent) => attach(agent),
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
          confidence: c.confidence,
          body: c.body,
        })),
        trajectory,
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

// Judge: review clearly identifies the async/forEach bug. The keyword-matching
// version of this judge was too lenient — any mention of "promise" in any
// context scored 1. The LLM judge instead requires a clear identification.
const AsyncBugDetectedJudge = createLlmJudge<EvalInput, EvalOutput>(
  'AsyncBugDetectedJudge',
  'The review must clearly identify that calling Array.prototype.forEach with an async callback is a bug — either because the returned promises are not awaited, errors are swallowed, or callers cannot observe completion. A bare mention of "promise" or "async" without explaining the forEach-specific problem does NOT pass.',
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

// Recording-only trajectory judge: surfaces turn count and tool call summary in
// the judge metadata so eval runs reveal the agent's path, not just its output.
// Always scores 1 — used purely for observability. Loop detection lives in
// its own recording-only block below.
const TrajectoryShapeJudge = createJudge(
  'TrajectoryShapeJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    const traj = output.trajectory;
    const toolCounts: Record<string, number> = {};
    for (const call of traj.toolCalls) {
      toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
    }
    return {
      score: 1,
      metadata: {
        rationale: `Agent ran ${traj.turns} turn(s) with ${traj.toolCalls.length} tool call(s)`,
        turns: traj.turns,
        toolCallCount: traj.toolCalls.length,
        toolCounts,
      },
    };
  },
);

// Judge: when skills are configured, the agent should Read at least one skill
// file. A skill loaded but never read is a silent regression — the system
// prompt references the skill, but the model ignored the instruction to load
// it. Used in a recording-only block so a single miss doesn't flake CI, but
// persistent score=0 across runs signals broken skill loading.
const SkillFileReadJudge = createJudge(
  'SkillFileReadJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    // pi-coding-agent's read tool uses `args.path`; older wrappers used
    // `args.file_path`. Accept either. The first incarnation of this judge
    // only checked `file_path` and produced false negatives across every
    // skill-enabled run — the agent was reading skills all along.
    const reads = output.trajectory.toolCalls
      .filter((c) => c.name === 'Read' || c.name === 'read')
      .map((c) => String(c.args.path ?? c.args.file_path ?? ''));
    const skillReads = reads.filter((p) => p.includes('skills/') || p.includes('SKILL.md'));
    return {
      score: skillReads.length > 0 ? 1 : 0,
      metadata: {
        rationale:
          skillReads.length > 0
            ? `Agent read ${skillReads.length} skill file(s)`
            : 'Agent did not read any skill file — skill loading may be ineffective',
        skillReads,
        allReads: reads.slice(0, 10),
      },
    };
  },
);

describeEval(
  'code-review skill — bug detection',
  {
    harness: reviewHarness,
    judges: [AsyncBugDetectedJudge, HasSevereFindingJudge, TrajectoryShapeJudge],
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

// Recording-only trajectory health: surfaces whether the agent is reading
// configured skill files and whether turn counts are reasonable. These signals
// are not enforced (LLM behaviour varies), but persistent score=0 across runs
// is the first place to look when reviews start regressing for non-obvious
// reasons.
describeEval(
  'trajectory — skill file is read when configured (recording only)',
  {
    harness: reviewHarness,
    judges: [SkillFileReadJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('reads skill file when code-review skill is enabled', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'async-foreach-bug.diff'), 'utf8');
      const result = await run({ diff, skills: ['code-review'] });
      expect(result.output.trajectory.turns).toBeGreaterThan(0);
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

// Judge: review identifies the missing deps / stale closure in useEffect.
const StaleClosureJudge = createLlmJudge<EvalInput, EvalOutput>(
  'StaleClosureJudge',
  'The review must clearly identify a React stale-closure bug: a useEffect (or similar hook) that reads a value but omits it from the dependency array, so the effect captures the stale initial value. A generic warning about "missing dependencies" without explaining the resulting incorrect behaviour does NOT pass.',
);

// Judge: review identifies the race condition in the PHP promo code handler.
const RaceConditionJudge = createLlmJudge<EvalInput, EvalOutput>(
  'RaceConditionJudge',
  'The review must clearly identify that two concurrent requests can both succeed in claiming the same promo code because the read-then-write sequence is not atomic. Equivalent framings (race condition, non-atomic update, missing row lock, missing transaction, TOCTOU) all count. A vague suggestion to "use a transaction" without naming the race does NOT pass.',
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

// Judge: review identifies that the module-level cache is not keyed by user,
// so it leaks one user's token to every subsequent caller.
const GlobalCacheBugJudge = createLlmJudge<EvalInput, EvalOutput>(
  'GlobalCacheBugJudge',
  "The review must clearly identify that a module-level / shared cache is missing a per-user key, so the first user's cached value is returned to every subsequent user. Calling out cross-user leakage, shared state, or that the cache should be keyed by userId all count. A general comment about caching strategy without the cross-user defect does NOT pass.",
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
    // Enforcing. The fixture is now a truly concern-free HTTP-status
    // constants module — there is nothing the reviewer can legitimately
    // flag at CRITICAL or WARN. If this judge starts scoring 0, the
    // reviewer is fabricating severe findings and needs investigation.
    // (The previous MemoryCache fixture genuinely had an unbounded-growth
    // concern; the eval was kept recording-only because the model was
    // correct to flag it.)
    judgeThreshold: 1,
    skipIf: missingApiKey,
  },
  (it) => {
    it('produces no severe findings on clean code with skill enabled', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'clean-ts.diff'), 'utf8');
      const result = await run({ diff, skills: ['code-review'] });
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
// Honesty / refusal — confidence calibration under uncertainty
//
// "A confident wrong answer is worse than an honest 'I don't know.'" These
// evals target the floor-raising case: given diffs that LOOK suspicious but
// are demonstrably intentional (each unusual pattern is justified by an
// in-file comment), the reviewer must not fabricate CRITICAL/WARN findings.
//
// HonestRefusalJudge is an LLM judge that scores 1 only when every severe
// finding is supported by a real, reproducible defect — not by stylistic
// preference, speculation, or pattern-matching on superficial signals.
// =============================================================================

const HonestRefusalJudge = createLlmJudge<EvalInput, EvalOutput>(
  'HonestRefusalJudge',
  'Every CRITICAL or WARN finding in the review must point to a real, reproducible defect supported by the diff. Score 0 if any severe finding is speculative ("could potentially..."), stylistic, contradicted by an in-file comment that justifies the pattern, or based on external context not visible in the diff. Score 1 if there are no severe findings OR if every severe finding identifies a concrete defect with observable impact. INFO-level nits and suggestions are out of scope — only judge CRITICAL and WARN.',
);

describeEval(
  'honesty — no fabricated severe findings on justified-intentional code',
  {
    harness: reviewHarness,
    judges: [HonestRefusalJudge, NoSevereFindingsJudge],
    // Recording-only. The first end-to-end run showed real LLM variance
    // here: the reviewer fabricated a CRITICAL "timer leak" finding on the
    // probe code despite the finally-block clearTimeout call. That is exactly
    // the failure mode this eval is meant to surface, but model-driven
    // variance means an enforcing threshold would flake CI. Promote to
    // judgeThreshold: 1 once the reviewer prompt is hardened around
    // unfounded severe findings, or once we have ≥3 consecutive 1.00 runs
    // across model upgrades.
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('reviews suspicious-but-justified probe code without inventing severe findings', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'justified-intentional.diff'), 'utf8');
      const result = await run({ diff, skills: ['code-review'] });
      expect(result.output).toBeDefined();
    });
  },
);

// Baseline: same fixture, no skill. Recording-only so we see whether the
// honesty signal depends on the skill being loaded.
describeEval(
  'honesty — no fabricated severe findings (baseline, no skill)',
  {
    harness: reviewHarness,
    judges: [HonestRefusalJudge, NoSevereFindingsJudge],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it('justified-intentional code baseline without code-review skill', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'justified-intentional.diff'), 'utf8');
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

// Judge: does the reviewer raise missing authentication as a SEVERE concern?
// Score=1 means the concern was raised at CRITICAL or WARN level.
// For scenario A we expect this to drop from 1→0 when the prior thread explains
// the endpoint is protected at the network layer.
const AuthConcernRaisedJudge = createLlmJudge<EvalInput, EvalOutput>(
  'AuthConcernRaisedJudge',
  'The review must raise missing authentication / authorization / access control as a CRITICAL or WARN concern (not just an INFO suggestion). Score=1 only if at least one CRITICAL- or WARN-severity finding clearly flags the lack of auth. INFO-level mentions, suggestions to "consider adding auth", or summary-only remarks without a severe inline finding do NOT pass.',
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
const NullDereferenceFlaggedJudge = createLlmJudge<EvalInput, EvalOutput>(
  'NullDereferenceFlaggedJudge',
  'The review must flag a concrete null / undefined dereference as CRITICAL or WARN: an optional field (e.g. typed as `Product | undefined`) being accessed without a null check, which will throw a TypeError at runtime. INFO-level suggestions, generic type-safety nits, or a vague mention without identifying the actual unguarded access do NOT pass.',
);

// =============================================================================
// Output format — Conventional Comments + summary skeleton
//
// These judges enforce the format directives in buildJSONSystemPrompt:
//   1. Every inline comment body opens with a Conventional Comments header
//      (https://conventionalcomments.org/): `<label> [decoration]: <subject>`
//   2. Label and decoration match the structured severity field:
//      CRITICAL → "issue (blocking):"
//      WARN     → "issue:" (no decoration)
//      INFO     → nitpick / suggestion (non-blocking) / note / question / thought
//   3. The summary contains the skeleton sections (### Overview, ### Findings)
//      and does NOT duplicate the discussion text from inline comments — the
//      anti-duplication rule keeps the summary scannable.
// =============================================================================

const ALLOWED_LABELS = [
  'issue',
  'suggestion',
  'nitpick',
  'question',
  'todo',
  'chore',
  'note',
  'thought',
] as const;

const CONVENTIONAL_HEADER_RE = new RegExp(
  String.raw`^\s*(${ALLOWED_LABELS.join('|')})(\s+\((?:blocking|non-blocking|if-minor)\))?:\s+\S`,
);

const ConventionalCommentFormatJudge = createJudge(
  'ConventionalCommentFormatJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    if (output.comments.length === 0) {
      return {
        score: 1,
        metadata: { rationale: 'No comments to validate (vacuous pass).' },
      };
    }

    const violations: { file: string; line: number; reason: string; preview: string }[] = [];

    for (const c of output.comments) {
      const first = c.body.split('\n', 1)[0] ?? '';
      if (!CONVENTIONAL_HEADER_RE.test(first)) {
        violations.push({
          file: c.file,
          line: c.line,
          reason: 'first line is not a Conventional Comments header',
          preview: first.slice(0, 120),
        });
        continue;
      }
      // Severity → label/decoration mapping
      const headerMatch = first.match(CONVENTIONAL_HEADER_RE);
      const label = headerMatch?.[1];
      const decoration = (headerMatch?.[2] ?? '').trim();
      if (c.severity === 'critical' && !(label === 'issue' && decoration === '(blocking)')) {
        violations.push({
          file: c.file,
          line: c.line,
          reason: `CRITICAL must use "issue (blocking):" (got "${label}${decoration ? ` ${decoration}` : ''}:")`,
          preview: first.slice(0, 120),
        });
      } else if (c.severity === 'warn' && !(label === 'issue' && decoration === '')) {
        violations.push({
          file: c.file,
          line: c.line,
          reason: `WARN must use bare "issue:" (got "${label}${decoration ? ` ${decoration}` : ''}:")`,
          preview: first.slice(0, 120),
        });
      } else if (c.severity === 'info' && label === 'issue') {
        violations.push({
          file: c.file,
          line: c.line,
          reason: 'INFO must use nitpick / suggestion (non-blocking) / note / question / thought',
          preview: first.slice(0, 120),
        });
      }
    }

    return {
      score: violations.length === 0 ? 1 : 0,
      metadata: {
        rationale:
          violations.length === 0
            ? `All ${output.comments.length} comment(s) conform to Conventional Comments format and severity mapping`
            : `${violations.length}/${output.comments.length} comment(s) violate the format/mapping`,
        violations,
      },
    };
  },
);

const SummarySkeletonJudge = createJudge(
  'SummarySkeletonJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    // Empty-findings sentinel is also valid output.
    if (output.summary.trim() === 'No issues found in the reviewed diff.') {
      return {
        score: 1,
        metadata: { rationale: 'Used the empty-findings sentinel.' },
      };
    }
    const hasOverview = /^###\s+Overview\b/m.test(output.summary);
    const hasFindings = /^###\s+Findings\b/m.test(output.summary);
    const score = hasOverview && hasFindings ? 1 : 0;
    return {
      score,
      metadata: {
        rationale:
          score === 1 ? 'Summary follows the skeleton' : 'Summary missing skeleton sections',
        hasOverview,
        hasFindings,
        summaryHead: output.summary.slice(0, 200),
      },
    };
  },
);

// Anti-duplication: the summary's Findings bullets should restate only the
// comment subject, not the comment's discussion. We extract the discussion
// (everything after the first newline of each comment body) and check that no
// distinctive sentence from it appears verbatim in the summary.
const NoDuplicationJudge = createJudge(
  'NoDuplicationJudge',
  ({ output }: JudgeContext<EvalInput, EvalOutput, Record<string, unknown>>) => {
    if (output.comments.length === 0) {
      return {
        score: 1,
        metadata: { rationale: 'No comments to check for duplication.' },
      };
    }
    const summary = output.summary;
    const dupes: { file: string; line: number; sentence: string }[] = [];

    for (const c of output.comments) {
      const newlineIdx = c.body.indexOf('\n');
      if (newlineIdx === -1) continue;
      const discussion = c.body.slice(newlineIdx + 1).trim();
      if (!discussion) continue;
      // Take the first sentence of the discussion (trim noise like code fences).
      const cleaned = discussion.replace(/^[`*\s>]+/, '').trim();
      const sentence = cleaned.split(/[.!?]\s|\n/)[0]?.trim() ?? '';
      // Skip very short sentences that may legitimately overlap (e.g. file names).
      if (sentence.length < 40) continue;
      if (summary.includes(sentence)) {
        dupes.push({ file: c.file, line: c.line, sentence: sentence.slice(0, 120) });
      }
    }

    return {
      score: dupes.length === 0 ? 1 : 0,
      metadata: {
        rationale:
          dupes.length === 0
            ? 'Summary does not duplicate comment discussion text'
            : `Summary duplicates ${dupes.length} comment discussion sentence(s)`,
        duplicates: dupes,
      },
    };
  },
);

describeEval(
  'output format — Conventional Comments + summary skeleton',
  {
    harness: reviewHarness,
    judges: [ConventionalCommentFormatJudge, SummarySkeletonJudge, NoDuplicationJudge],
    // Format/mapping conformance is required; duplication is recorded but soft.
    judgeThreshold: 1,
    skipIf: missingApiKey,
  },
  (it) => {
    it('async/forEach diff: comments use Conventional Comments + summary follows skeleton', async ({
      run,
    }) => {
      const diff = await readFile(join(FIXTURES, 'async-foreach-bug.diff'), 'utf8');
      const result = await run({ diff, skills: ['code-review'] });
      expect(result.output).toBeDefined();
      expect(result.output.summary.length).toBeGreaterThan(0);
    });

    it('clean diff: emits the empty-findings sentinel or a conforming summary', async ({ run }) => {
      const diff = await readFile(join(FIXTURES, 'clean-ts.diff'), 'utf8');
      const result = await run({ diff, skills: ['code-review'] });
      expect(result.output).toBeDefined();
    });
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
