/**
 * Comparative harness for the input-mode eval: run the same synthetic change
 * through each way of presenting it to the reviewer and score per-bug recall,
 * precision, cost, and read-coverage on the same ground truth.
 *
 * Arms:
 * - inline:              diff in the prompt (baseline).
 * - disk:                every file diff staged on disk; agent reads on demand.
 * - commits-full:        agent walks the whole change via read-only git tools.
 * - commits-incremental: git tools, scoped to the commits after the first
 *                        (models "review only what's new since last time");
 *                        ground truth is restricted to the in-scope commits.
 *
 * The arm's createAgent is injectable so the wiring can be exercised with a stub
 * (no API) in unit tests and with the real agent in the gated eval run.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Config } from '../../src/config.js';
import { resolveProviderApiKey } from '../../src/config.js';
import type { CreateAgent } from '../../src/gitlab-review.js';
import { runReview } from '../../src/gitlab-review.js';
import { parseReviewMarkdownWithWarnings } from '../../src/parser.js';
import type { ReviewInputMode } from '../../src/types.js';
import type { MaterializedRepo } from './materialize.js';
import { scoreReview, type ScoreResult } from './scoring.js';
import type { PlantedBug, SyntheticReview } from './synthetic.js';
import { createTrajectoryCollector, filesRead, type Trajectory } from './trajectory.js';

export const EVAL_MODEL = process.env.CODE_REVIEW_EVAL_MODEL ?? 'cloudflare-ai-gateway/gpt-5.4';

export interface Arm {
  label: string;
  inputMode: ReviewInputMode;
  /** commits mode only: review just the commits after the first commit. */
  incremental?: boolean;
}

export const ARMS: Arm[] = [
  { label: 'inline', inputMode: 'inline' },
  { label: 'disk', inputMode: 'disk' },
  { label: 'commits-full', inputMode: 'commits' },
  { label: 'commits-incremental', inputMode: 'commits', incremental: true },
];

export interface ArmResult {
  arm: string;
  score: ScoreResult;
  tokens: number;
  cost: number;
  turns: number;
  /** git_show/git_diff/git_log calls (commit-exploration arms). */
  gitToolCalls: number;
}

// Mirror of skipped-retrieval's slugify, to map a staged read path back to its
// source file for read-coverage. Kept local so scoring stays layout-agnostic.
function slugOf(path: string): string {
  return `${path.replace(/[^a-zA-Z0-9._-]/g, '__')}.diff`;
}

function makeConfig(overrides: Partial<Config>): Config {
  const model = overrides.model ?? EVAL_MODEL;
  return {
    project: 'test',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'test',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model,
    modelPool: [],
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    reviewDepth: 'single',
    apiKey: resolveProviderApiKey(model),
    baseUrl: process.env.CODE_REVIEW_BASE_URL ?? '',
    maxTokens: Number(process.env.CODE_REVIEW_MAX_TOKENS ?? 0),
    maxDiffChars: 100_000,
    decomposeHintLines: 0,
    reviewFile: 'code-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: true,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: process.cwd(),
    skills: [],
    refreshGitSkills: false,
    ...overrides,
  };
}

function countGitToolCalls(trajectory: Trajectory): number {
  return trajectory.toolCalls.filter((c) => c.name.startsWith('git_')).length;
}

/** Source files the agent opened, mapping staged-diff read paths back to source. */
function resolveFilesRead(trajectory: Trajectory, allFiles: string[]): string[] {
  const reads = filesRead(trajectory).map((p) => basename(p));
  const bySlug = new Map(allFiles.map((f) => [slugOf(f), f]));
  const out = new Set<string>();
  for (const read of reads) {
    if (bySlug.has(read)) out.add(bySlug.get(read)!); // disk mode: slugged diff
    const direct = allFiles.find((f) => basename(f) === read);
    if (direct) out.add(direct); // inline/commits mode: real source path
  }
  return [...out];
}

export interface RunArmOptions {
  review: SyntheticReview;
  arm: Arm;
  /** Required for commit-exploration arms (the materialized repo). */
  repo?: MaterializedRepo;
  model?: string;
  createAgent?: CreateAgent;
}

export async function runArm(options: RunArmOptions): Promise<ArmResult> {
  const { review, arm, repo } = options;
  const commitsMode = arm.inputMode === 'commits';
  if (commitsMode && !repo) {
    throw new Error(`Arm "${arm.label}" needs a materialized repo`);
  }

  // Incremental scope: everything after the first commit is "unreviewed".
  const scopeFiles = arm.incremental
    ? new Set(review.commits.slice(1).flatMap((c) => c.files))
    : new Set(review.files.map((f) => f.path));
  const groundTruth: PlantedBug[] = arm.incremental
    ? review.groundTruth.filter((b) => scopeFiles.has(b.file))
    : review.groundTruth;
  const allFiles = [...scopeFiles];
  const sinceRef = arm.incremental ? repo!.oids[0] : undefined;

  const ownsCwd = !commitsMode;
  const cwd = commitsMode ? repo!.dir : await mkdtemp(join(tmpdir(), 'input-mode-'));
  try {
    const config = makeConfig({ cwd, inputMode: arm.inputMode, model: options.model });
    const { trajectory, attach } = createTrajectoryCollector();
    const usage = await runReview(config, {
      diff: review.diff,
      sinceRef,
      createAgent: options.createAgent,
      attachTelemetry: (agent) => attach(agent),
    });

    const raw = await readFile(join(cwd, config.reviewFile), 'utf8');
    const parsed = parseReviewMarkdownWithWarnings(raw);
    const score = scoreReview({
      comments: parsed.comments,
      groundTruth,
      filesReadSource: resolveFilesRead(trajectory, allFiles),
      allFiles,
    });

    return {
      arm: arm.label,
      score,
      tokens: usage.tokens.total,
      cost: usage.cost.total,
      turns: trajectory.turns,
      gitToolCalls: countGitToolCalls(trajectory),
    };
  } finally {
    if (ownsCwd) await rm(cwd, { recursive: true, force: true });
  }
}
