import { describe, expect, it } from 'vitest';
import { getMergeDiffArguments } from './git.js';

describe('git', () => {
  it('builds the same merge diff arguments used for review and comment positions', () => {
    expect(getMergeDiffArguments('develop')).toEqual([
      'refs/remotes/origin/develop...HEAD',
      '--unified=20',
      '--',
    ]);
  });
});
