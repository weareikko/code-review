import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Config } from './config.js';
import type { DiffRefs, GeneratedComment } from './types.js';

import { resolveConfig, validateConfig } from './config.js';
import { formatError, RuntimeError } from './errors.js';
import { extractExistingFingerprints } from './fingerprints.js';
import { getMergeDiff, prepareGitHistory } from './git.js';
import { GitLabClient } from './gitlab.js';
import { parseReviewMarkdownWithWarnings } from './parser.js';
import { buildGeneratedComments } from './payloads.js';
import { runPiReviewer } from './pi-reviewer.js';
import { postGeneratedComments } from './posting.js';

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
  --review-file <path>    Raw pi-reviewer output file (default: pi-review.md)
  --output <path>         Generated payload artifact (default: review-comments.json)
  --dry-run               Generate artifacts and skip posting
  --no-post               Generate artifacts and skip posting
  --help, -h              Show help
  --version, -v           Show version
`;

export interface RunResult {
  generated: GeneratedComment[];
  posted: number;
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

  const gitlab = new GitLabClient({
    gitlabUrl: config.gitlabUrl,
    token: config.gitlabToken,
    authHeader: config.gitlabAuthHeader,
  });

  const mr = await gitlab.getMergeRequest(config.project, config.mr);
  const version = await gitlab.getLatestVersion(config.project, config.mr);

  await prepareGitHistory(mr.source_branch, mr.target_branch, { cwd: config.cwd });
  const diff = await getMergeDiff(mr.target_branch, { cwd: config.cwd });
  await runPiReviewer(config, { cwd: config.cwd, diff });

  const reviewPath = resolve(config.cwd, config.reviewFile);
  const review = await readFile(reviewPath, 'utf8');
  const parsed = parseReviewMarkdownWithWarnings(review);
  for (const warning of parsed.warnings) console.warn(`[gitlab-review] ${warning}`);

  const discussions = await gitlab.getDiscussions(config.project, config.mr);
  const existing = extractExistingFingerprints(discussions);
  const generated = buildGeneratedComments(
    parsed.comments,
    diff,
    refsFromVersion(version),
    existing,
  );

  const outputPath = resolve(config.cwd, config.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(generated, null, 2), 'utf8');

  const newCount = generated.filter((item) => !item.duplicate).length;
  if (config.dryRun || config.noPost) {
    console.log(`Generated ${generated.length} comments, ${newCount} new. Posting disabled.`);
    return { generated, posted: 0 };
  }

  const posted = await postGeneratedComments(gitlab, config.project, config.mr, generated);
  console.log(
    `Posted ${posted} new GitLab MR discussions (${generated.length - posted} duplicates skipped).`,
  );
  return { generated, posted };
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
  await run(config);
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
