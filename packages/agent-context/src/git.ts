import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';
import { GitError } from './errors.js';

const exec = promisify(execFile);

export interface GitOptions {
  cwd?: string;
}

function gitErrorMessage(error: unknown): string {
  const err = error as ExecFileException & { stderr?: string; stdout?: string };
  return [err.message, err.stderr, err.stdout].filter(Boolean).join('\n').trim();
}

/** Run `git` with `args` and return its stdout. Throws a `GitError` on failure. */
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

/**
 * The top-level directory of the git work tree that holds `cwd`, or `cwd`
 * itself when it is not inside a work tree (or git is not installed).
 */
export async function findGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}
