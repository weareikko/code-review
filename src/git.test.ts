import { describe, expect, it } from 'vitest';
import { getMergeCommitLogArguments, getMergeDiffArguments } from './git.js';

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
});
