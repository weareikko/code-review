import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getMergeCommitLog,
  getMergeCommitLogArguments,
  getMergeDiff,
  getMergeDiffArguments,
  getMergeDiffCommand,
  git,
  prepareGitHistory,
  summarizeDiff,
} from './git.js';

describe('git', () => {
  it('builds the same merge diff arguments used for review and comment positions', () => {
    expect(getMergeDiffArguments('develop', 'abc1234')).toEqual([
      'refs/remotes/origin/develop...abc1234',
      '--unified=20',
      '--',
    ]);
  });

  it('disables core.quotepath so non-ASCII paths are emitted literally (not octal-quoted)', () => {
    // With the default quotepath=true, git emits `--- "a/caf\303\251.ts"`, which
    // the comment-position parser cannot match → comments fall back to invalid
    // one-sided positions. The diff invocation must disable it.
    expect(getMergeDiffCommand('develop', 'abc1234')).toEqual([
      '-c',
      'core.quotepath=false',
      'diff',
      'refs/remotes/origin/develop...abc1234',
      '--unified=20',
      '--',
    ]);
  });

  describe('getMergeCommitLogArguments', () => {
    it('targets the correct ref range with default remote', () => {
      const args = getMergeCommitLogArguments('main', 'abc1234');
      expect(args[0]).toBe('refs/remotes/origin/main...abc1234');
    });

    it('uses a custom remote when provided', () => {
      const args = getMergeCommitLogArguments('main', 'abc1234', { remote: 'upstream' });
      expect(args[0]).toBe('refs/remotes/upstream/main...abc1234');
    });

    it('uses chronological order and excludes merge commits', () => {
      const args = getMergeCommitLogArguments('main', 'abc1234');
      expect(args).toContain('--reverse');
      expect(args).toContain('--no-merges');
    });

    it('formats each commit with hash, author, date, and full message', () => {
      const args = getMergeCommitLogArguments('main', 'abc1234');
      const formatArg = args.find((a) => a.startsWith('--pretty='));
      expect(formatArg).toBeDefined();
      // Must include the key placeholders
      expect(formatArg).toContain('%h'); // abbreviated hash
      expect(formatArg).toContain('%an'); // author name
      expect(formatArg).toContain('%as'); // author date (short)
      expect(formatArg).toContain('%s'); // subject
      expect(formatArg).toContain('%b'); // body
    });
  });

  describe('summarizeDiff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' context line',
      '-removed line',
      '+added line 1',
      '+added line 2',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n');

    it('counts changed files, added lines, and removed lines', () => {
      expect(summarizeDiff(diff)).toEqual({
        filesChanged: 2,
        linesAdded: 4,
        linesRemoved: 1,
      });
    });

    it('does not count +++/--- file headers as content lines', () => {
      const { linesAdded, linesRemoved } = summarizeDiff(diff);
      // 4 real additions (not the two +++ headers); 1 real removal (not the
      // two --- headers, one of which is /dev/null).
      expect(linesAdded).toBe(4);
      expect(linesRemoved).toBe(1);
    });

    it('returns zeros for an empty diff', () => {
      expect(summarizeDiff('')).toEqual({ filesChanged: 0, linesAdded: 0, linesRemoved: 0 });
    });

    it('counts in-hunk content lines whose text begins with ++ or --', () => {
      // An added line with content `++x` renders as `+++x`; a removed line with
      // content `--x` renders as `---x`. These are content, not file headers.
      const tricky = [
        'diff --git a/x.md b/x.md',
        'index 1111111..2222222 100644',
        '--- a/x.md',
        '+++ b/x.md',
        '@@ -1,2 +1,2 @@',
        '---removed dashes',
        '+++added pluses',
        '',
      ].join('\n');
      expect(summarizeDiff(tricky)).toEqual({
        filesChanged: 1,
        linesAdded: 1,
        linesRemoved: 1,
      });
    });
  });

  describe('merge diff with a stale CI merge commit', () => {
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
    const commit = async (cwd: string, file: string, message: string) => {
      await writeFile(join(cwd, file), `${file}\n`);
      await git(['add', file], { cwd });
      await git([...identity, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], {
        cwd,
      });
      return (await git(['rev-parse', 'HEAD'], { cwd })).trim();
    };
    const merge = async (cwd: string, ref: string) => {
      await git(
        [...identity, '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '--no-edit', ref],
        {
          cwd,
        },
      );
    };

    it('diffs the target with the MR head commit, not with HEAD', async () => {
      const root = await mkdtemp(join(tmpdir(), 'code-review-git-'));
      try {
        const origin = join(root, 'origin.git');
        const work = join(root, 'work');
        const ci = join(root, 'ci');
        await git(['init', '-q', '--bare', '-b', 'main', origin]);
        await git(['clone', '-q', origin, work]);
        await commit(work, 'readme.txt', 'Initial commit');
        // A stacked MR: `feature` targets `base`, which is behind `main`.
        await git(['switch', '-q', '-c', 'base'], { cwd: work });
        await commit(work, 'base.txt', 'Base change');
        await git(['switch', '-q', '-c', 'feature'], { cwd: work });
        const head = await commit(work, 'feature.txt', 'Feature change');
        await git(['switch', '-q', 'main'], { cwd: work });
        await commit(work, 'unrelated.txt', 'Unrelated change');
        await git(['push', '-q', 'origin', 'main', 'base', 'feature'], { cwd: work });

        // CI checks out a merge commit built on a base that also holds `main`.
        await git(['clone', '-q', origin, ci]);
        await merge(ci, 'origin/base');
        await merge(ci, head);
        const stale = await git(['diff', '--name-only', 'origin/base...HEAD'], { cwd: ci });
        expect(stale).toContain('unrelated.txt');

        await prepareGitHistory('feature', 'base', head, { cwd: ci });
        const diff = await getMergeDiff('base', head, { cwd: ci });
        expect(summarizeDiff(diff).filesChanged).toBe(1);
        expect(diff).toContain('diff --git a/feature.txt b/feature.txt');
        const log = await getMergeCommitLog('base', head, { cwd: ci });
        expect(log).toContain('Feature change');
        expect(log).not.toContain('Unrelated change');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('fails with a hint when the MR head commit is unknown', async () => {
      const root = await mkdtemp(join(tmpdir(), 'code-review-git-'));
      try {
        const origin = join(root, 'origin.git');
        const work = join(root, 'work');
        await git(['init', '-q', '--bare', '-b', 'main', origin]);
        await git(['clone', '-q', origin, work]);
        await commit(work, 'readme.txt', 'Initial commit');
        await git(['push', '-q', 'origin', 'main'], { cwd: work });

        const missing = 'f'.repeat(40);
        await expect(prepareGitHistory('feature', 'main', missing, { cwd: work })).rejects.toThrow(
          `merge-base refs/remotes/origin/main ${missing} failed`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
