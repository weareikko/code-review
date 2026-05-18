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
  const remote = options.remote ?? 'origin';
  const context = options.context ?? 20;
  return git(
    ['diff', `${remoteRef(remote, targetBranch)}...HEAD`, `--unified=${context}`, '--'],
    options,
  );
}
