import { describe, expect, it } from 'vitest';
import { getMergeCommitLogArguments, getMergeDiffArguments, summarizeDiff } from './git.js';

describe('git', () => {
  it('builds the same merge diff arguments used for review and comment positions', () => {
    expect(getMergeDiffArguments('develop')).toEqual([
      'refs/remotes/origin/develop...HEAD',
      '--unified=20',
      '--',
    ]);
  });

  describe('getMergeCommitLogArguments', () => {
    it('targets the correct ref range with default remote', () => {
      const args = getMergeCommitLogArguments('main');
      expect(args[0]).toBe('refs/remotes/origin/main...HEAD');
    });

    it('uses a custom remote when provided', () => {
      const args = getMergeCommitLogArguments('main', { remote: 'upstream' });
      expect(args[0]).toBe('refs/remotes/upstream/main...HEAD');
    });

    it('uses chronological order and excludes merge commits', () => {
      const args = getMergeCommitLogArguments('main');
      expect(args).toContain('--reverse');
      expect(args).toContain('--no-merges');
    });

    it('formats each commit with hash, author, date, and full message', () => {
      const args = getMergeCommitLogArguments('main');
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
});
