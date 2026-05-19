import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Config } from './config.js';
import type { ReviewUsage } from './pi-reviewer.js';
import type { DiffRefs, GeneratedComment } from './types.js';

import { resolveConfig, validateConfig } from './config.js';
import {
  createDiagnosticRunId,
  traceDiagnosticPhase,
  type DiagnosticContext,
} from './diagnostics.js';
import { formatError, RuntimeError } from './errors.js';
import { extractExistingFingerprints } from './fingerprints.js';
import { getMergeDiff, prepareGitHistory } from './git.js';
import { GitLabClient } from './gitlab.js';
import { startOtelBridge } from './otel.js';
import { parseReviewMarkdownWithWarnings } from './parser.js';
import { buildGeneratedComments } from './payloads.js';
import { runReview } from './pi-reviewer.js';
import { postGeneratedComments } from './posting.js';

export type { DiagnosticContext, DiagnosticError, DiagnosticPhase } from './diagnostics.js';
export {
  DIAGNOSTIC_CHANNEL_NAMES,
  DIAGNOSTIC_CHANNEL_PREFIX,
  createDiagnosticContext,
  createDiagnosticRunId,
  diagnosticChannels,
  traceDiagnostic,
  traceDiagnosticPhase,
} from './diagnostics.js';

const HELP = `Usage: gitlab-review [options]

Run pi-reviewer in GitLab CI and post deduplicated merge request discussions.

Options:
  --project <id>          GitLab project ID/path (default: CI_PROJECT_ID)
  --mr <iid>              Merge request IID (default: CI_MERGE_REQUEST_IID)
  --gitlab-url <url>      GitLab URL (default: CI_SERVER_URL or CI_SERVER_HOST)
  --gitlab-token <token>  GitLab token (default: GITLAB_TOKEN, GLAB_CLI_TOKEN, CI_JOB_TOKEN, GITLAB_PRIVATE_TOKEN)
  --api-key <key>         pi/AI API key (default: PI_API_KEY, ANTHROPIC_API_KEY, CLAUDE_API_KEY)
  --model <provider/id>   pi-reviewer model (default: anthropic/claude-sonnet-4-5)
  --min-severity <level>  info, warn, or critical (default: info)
  --thinking <level>      off, minimal, low, medium, high, or xhigh (default: off).
                          Higher levels add billable thinking tokens at the model output rate.
  --posting-mode <mode>   direct (sequential discussions) or draft (atomic bulk publish)
                          (default: direct)
  --review-file <path>    Raw pi-reviewer output file (default: pi-review.md)
  --output <path>         Generated payload artifact (default: review-comments.json)
  --cwd <path>            Working directory (default: process.cwd())
  --dry-run               Generate artifacts and skip posting
  --no-post               Generate artifacts and skip posting
  --help, -h              Show help
  --version, -v           Show version
`;

export interface RunResult {
  generated: GeneratedComment[];
  posted: number;
  usage: ReviewUsage;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function assertNodeVersion(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new RuntimeError(
      `Node.js >=24 is required; current version is ${process.versions.node}.`,
      {
        hint: 'Use a Node 24 image/runtime in GitLab CI.',
      },
    );
  }
}

function refsFromVersion(version: {
  base_commit_sha: string;
  start_commit_sha: string;
  head_commit_sha: string;
}): DiffRefs {
  return {
    base_sha: version.base_commit_sha,
    start_sha: version.start_commit_sha,
    head_sha: version.head_commit_sha,
  };
}

export async function run(config: Config): Promise<RunResult> {
  validateConfig(config);

  const runId = createDiagnosticRunId();
  return traceDiagnosticPhase('run', config, runId, async (runContext) => {
    const gitlab = new GitLabClient({
      gitlabUrl: config.gitlabUrl,
      token: config.gitlabToken,
      authHeader: config.gitlabAuthHeader,
    });

    const mr = await traceDiagnosticPhase('gitlab.get_merge_request', config, runId, () =>
      gitlab.getMergeRequest(config.project, config.mr),
    );
    const version = await traceDiagnosticPhase('gitlab.get_latest_version', config, runId, () =>
      gitlab.getLatestVersion(config.project, config.mr),
    );

    await traceDiagnosticPhase('git.prepare_history', config, runId, () =>
      prepareGitHistory(mr.source_branch, mr.target_branch, { cwd: config.cwd }),
    );
    const diff = await traceDiagnosticPhase('git.get_merge_diff', config, runId, () =>
      getMergeDiff(mr.target_branch, { cwd: config.cwd }),
    );
    const usage = await traceDiagnosticPhase('reviewer.run', config, runId, async (context) => {
      const result = await runReview(config, { cwd: config.cwd, diff });
      context.usage = result;
      return result;
    });
    runContext.usage = usage;

    const reviewPath = resolve(config.cwd, config.reviewFile);
    const { parsed } = await traceDiagnosticPhase(
      'review.parse',
      config,
      runId,
      async (context) => {
        const review = await readFile(reviewPath, 'utf8');
        const result = parseReviewMarkdownWithWarnings(review);
        context.generated = result.comments.length;
        context.warnings = result.warnings.length;
        return { parsed: result };
      },
    );
    for (const warning of parsed.warnings) console.warn(`[gitlab-review] ${warning}`);

    const discussions = await traceDiagnosticPhase('gitlab.get_discussions', config, runId, () =>
      gitlab.getDiscussions(config.project, config.mr),
    );
    const existing = extractExistingFingerprints(discussions);
    const generated = await traceDiagnosticPhase(
      'comments.build',
      config,
      runId,
      async (context) => {
        const comments = buildGeneratedComments(
          parsed.comments,
          diff,
          refsFromVersion(version),
          existing,
        );
        recordCommentCounts(context, comments);
        return comments;
      },
    );

    const outputPath = resolve(config.cwd, config.output);
    const usagePath = resolve(config.cwd, 'review-usage.json');
    await traceDiagnosticPhase('artifact.write_output', config, runId, async (context) => {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(generated, null, 2), 'utf8');
      await writeFile(usagePath, JSON.stringify(usage, null, 2), 'utf8');
      recordCommentCounts(context, generated);
    });

    console.log(formatUsageLine(usage));

    const newCount = generated.filter((item) => !item.duplicate).length;
    recordCommentCounts(runContext, generated);
    if (config.dryRun || config.noPost) {
      console.log(`Generated ${generated.length} comments, ${newCount} new. Posting disabled.`);
      runContext.posted = 0;
      return { generated, posted: 0, usage };
    }

    const posted = await traceDiagnosticPhase(
      'gitlab.post_comments',
      config,
      runId,
      async (context) => {
        const result = await postGeneratedComments(
          gitlab,
          config.project,
          config.mr,
          generated,
          config.postingMode,
        );
        recordCommentCounts(context, generated);
        context.posted = result.posted;
        if (result.drafts) {
          context.draftsAbandoned = result.drafts.abandoned;
          context.draftsCreated = result.drafts.created;
          context.draftsDeletedPrePublish = result.drafts.deletedPrePublish;
          context.draftsPublished = result.drafts.published;
        }
        return result.posted;
      },
    );
    const duplicates = generated.length - newCount;
    const raceLost = newCount - posted;
    const extra = raceLost > 0 ? `, ${raceLost} dropped by pre-publish re-check` : '';
    console.log(
      `Posted ${posted} new GitLab MR discussions (${duplicates} duplicates skipped${extra}).`,
    );
    runContext.posted = posted;
    return { generated, posted, usage };
  });
}

export function formatUsageLine(usage: ReviewUsage): string {
  const formatter = new Intl.NumberFormat('en-US');
  const billableInput = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite;
  const inputLabel =
    usage.tokens.cacheRead > 0
      ? `${formatter.format(billableInput)} in (${formatter.format(usage.tokens.cacheRead)} cached)`
      : `${formatter.format(billableInput)} in`;
  const output = formatter.format(usage.tokens.output);
  const cost = usage.cost.total.toFixed(4);
  return `Review usage: ${inputLabel} / ${output} out tokens — $${cost} (${usage.model})`;
}

function recordCommentCounts(context: DiagnosticContext, generated: GeneratedComment[]): void {
  context.generated = generated.length;
  context.newComments = generated.filter((item) => !item.duplicate).length;
  context.duplicateComments = generated.length - context.newComments;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(readVersion());
    return;
  }

  assertNodeVersion();
  const config = resolveConfig(argv);
  const otel = await startOtelBridge();
  try {
    await run(config);
  } finally {
    await otel?.shutdown();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}
