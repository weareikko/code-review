import { describe, expect, it } from 'vitest';
import { generateSyntheticReview } from './synthetic.js';

describe('generateSyntheticReview', () => {
  const review = generateSyntheticReview({
    fillerFiles: 6,
    fillerLinesPerFile: 40,
    bugs: ['sql-injection', 'missing-await-loop', 'missing-authz'],
    commits: 3,
  });

  it('emits one file per bug plus the filler files, and one ground-truth entry per bug', () => {
    expect(review.files).toHaveLength(9);
    expect(review.groundTruth).toHaveLength(3);
    expect(review.files.filter((f) => f.hasBug)).toHaveLength(3);
  });

  it('records each planted bug at a line that actually contains the defect', () => {
    const byKind = Object.fromEntries(review.groundTruth.map((b) => [b.kind, b]));
    const contentFor = (path: string) =>
      review.files.find((f) => f.path === path)!.content.split('\n');

    const sql = byKind['sql-injection'];
    expect(contentFor(sql.file)[sql.line - 1]).toContain('SELECT * FROM');

    const authz = byKind['missing-authz'];
    expect(contentFor(authz.file)[authz.line - 1]).toContain('projects.delete');

    const loop = byKind['missing-await-loop'];
    expect(contentFor(loop.file)[loop.line - 1]).toContain('sink.persist');
  });

  it('produces a unified diff with a new-file section per file', () => {
    for (const file of review.files) {
      expect(review.diff).toContain(`diff --git a/${file.path} b/${file.path}`);
      expect(review.diff).toContain(`+++ b/${file.path}`);
    }
    expect(review.totalChars).toBe(review.diff.length);
  });

  it('partitions every file across the commits exactly once', () => {
    const inCommits = review.commits.flatMap((c) => c.files).sort();
    const allPaths = review.files.map((f) => f.path).sort();
    expect(inCommits).toEqual(allPaths);
    expect(review.commits).toHaveLength(3);
  });

  it('is deterministic', () => {
    const again = generateSyntheticReview({
      fillerFiles: 6,
      fillerLinesPerFile: 40,
      bugs: ['sql-injection', 'missing-await-loop', 'missing-authz'],
      commits: 3,
    });
    expect(again.diff).toBe(review.diff);
    expect(again.groundTruth).toEqual(review.groundTruth);
  });

  it('scales size via filler knobs', () => {
    const big = generateSyntheticReview({
      fillerFiles: 12,
      fillerLinesPerFile: 400,
      bugs: ['sql-injection'],
    });
    expect(big.totalChars).toBeGreaterThan(20_000);
  });
});
