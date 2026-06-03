import { execFile, type ExecFileException } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitError } from './errors.js';

const exec = promisify(execFile);

export interface GitOptions {
  cwd?: string;
}

export interface PrepareGitHistoryOptions extends GitOptions {
  remote?: string;
  codeQualityArtifacts?: string[];
}

const DEFAULT_DIFF_CONTEXT = 20;

const DEFAULT_CODEQUALITY_ARTIFACTS = [
  'gl-code-quality-report.json',
  'codequality.json',
  'codeclimate.json',
  'code-quality-report.json',
];

function gitErrorMessage(error: unknown): string {
  const err = error as ExecFileException & { stderr?: string; stdout?: string };
  return [err.message, err.stderr, err.stdout].filter(Boolean).join('\n').trim();
}

export async function git(args: string[], options: GitOptions = {}): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd: options.cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new GitError(`git ${args.join(' ')} failed.`, {
      cause: error,
      hint: gitErrorMessage(error),
    });
  }
}

function remoteRef(remote: string, branch: string): string {
  return `refs/remotes/${remote}/${branch}`;
}

export function getMergeDiffArguments(
  targetBranch: string,
  options: { remote?: string; context?: number } = {},
): string[] {
  const remote = options.remote ?? 'origin';
  const context = options.context ?? DEFAULT_DIFF_CONTEXT;
  return [`${remoteRef(remote, targetBranch)}...HEAD`, `--unified=${context}`, '--'];
}

async function fetchBranch(remote: string, branch: string, options: GitOptions): Promise<void> {
  await git(
    ['fetch', '--no-tags', remote, `+refs/heads/${branch}:${remoteRef(remote, branch)}`],
    options,
  );
}

async function isTracked(path: string, options: GitOptions): Promise<boolean> {
  try {
    await git(['ls-files', '--error-unmatch', '--', path], options);
    return true;
  } catch {
    return false;
  }
}

export async function removeGeneratedCodeQualityArtifacts(
  paths = DEFAULT_CODEQUALITY_ARTIFACTS,
  options: GitOptions = {},
): Promise<string[]> {
  const removed: string[] = [];
  for (const path of paths) {
    if (await isTracked(path, options)) continue;
    try {
      await unlink(options.cwd ? join(options.cwd, path) : path);
      removed.push(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

export async function prepareGitHistory(
  sourceBranch: string,
  targetBranch: string,
  options: PrepareGitHistoryOptions = {},
): Promise<void> {
  const remote = options.remote ?? 'origin';

  await removeGeneratedCodeQualityArtifacts(options.codeQualityArtifacts, options);

  // Unshallow first when possible. Git exits non-zero in full clones; that is not actionable.
  await git(['fetch', '--unshallow', '--no-tags', remote], options).catch(() => undefined);

  const fetchErrors: string[] = [];
  for (const branch of [targetBranch, sourceBranch]) {
    try {
      await fetchBranch(remote, branch, options);
    } catch (error) {
      fetchErrors.push(`${branch}: ${gitErrorMessage(error)}`);
    }
  }

  if (fetchErrors.length === 2) {
    throw new GitError(`Unable to fetch MR source/target branches from ${remote}.`, {
      hint: fetchErrors.join('\n'),
    });
  }

  try {
    await git(['merge-base', remoteRef(remote, targetBranch), 'HEAD'], options);
  } catch (error) {
    const fetchDetail =
      fetchErrors.length > 0 ? `\nFetch warnings:\n${fetchErrors.join('\n')}` : '';
    throw new GitError(
      `Unable to prepare Git history for MR review: merge-base ${remoteRef(remote, targetBranch)} HEAD failed.`,
      {
        cause: error,
        hint: `Set GIT_DEPTH: 0 or ensure ${remote}/${targetBranch} is fetchable.${fetchDetail}\n${gitErrorMessage(error)}`,
      },
    );
  }
}

export async function getMergeDiff(
  targetBranch: string,
  options: GitOptions & { remote?: string; context?: number } = {},
): Promise<string> {
  return git(['diff', ...getMergeDiffArguments(targetBranch, options)], options);
}

export function getMergeCommitLogArguments(
  targetBranch: string,
  options: { remote?: string } = {},
): string[] {
  const remote = options.remote ?? 'origin';
  return [
    `${remoteRef(remote, targetBranch)}...HEAD`,
    '--pretty=tformat:commit %h%nAuthor: %an%nDate: %as%n%n%s%n%n%b',
    '--reverse',
    '--no-merges',
  ];
}

export async function getMergeCommitLog(
  targetBranch: string,
  options: GitOptions & { remote?: string } = {},
): Promise<string> {
  return git(['log', ...getMergeCommitLogArguments(targetBranch, options)], options);
}

export interface DiffSummary {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Summarize a unified diff into file/line counts for telemetry. Counts one file
 * per `diff --git` header and counts `+`/`-` lines only inside a hunk (after a
 * `@@` header), so the `--- a/file` / `+++ b/file` header lines are excluded and
 * a genuine content line whose text starts with `++`/`--` is still counted. Pure
 * and allocation-light so it can run on the full merge diff without an extra git
 * invocation.
 */
export function summarizeDiff(diff: string): DiffSummary {
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      filesChanged += 1;
      inHunk = false;
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      linesAdded += 1;
    } else if (inHunk && line.startsWith('-')) {
      linesRemoved += 1;
    }
  }
  return { filesChanged, linesAdded, linesRemoved };
}
