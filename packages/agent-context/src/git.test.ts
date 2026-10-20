import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitError } from './errors.js';
import { findGitRoot, git } from './git.js';

describe('findGitRoot', () => {
  it('returns the work tree root from a nested directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-root-'));
    await git(['init', '--quiet', root]);
    const nested = join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    // `git rev-parse` resolves symlinks (macOS /var → /private/var), so compare
    // against what git reports for the root itself.
    expect(await findGitRoot(nested)).toBe(await findGitRoot(root));
    expect(await findGitRoot(nested)).not.toBe(nested);
  });

  it('returns cwd outside a work tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'no-git-'));
    expect(await findGitRoot(dir)).toBe(dir);
  });
});

describe('git', () => {
  it('throws a GitError with the command output as the hint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'no-git-'));
    const error = (await git(['log'], { cwd: dir }).catch((e: unknown) => e)) as GitError;
    expect(error).toBeInstanceOf(GitError);
    expect(error.code).toBe('GIT_ERROR');
    expect(error.hint).toMatch(/not a git repository/i);
  });
});
