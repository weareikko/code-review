import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '../../src/types.js';
import { scoreReview } from './scoring.js';
import type { PlantedBug } from './synthetic.js';

const bug = (over: Partial<PlantedBug> & Pick<PlantedBug, 'file' | 'line'>): PlantedBug => ({
  id: 'b',
  kind: 'sql-injection',
  severity: 'critical',
  description: '',
  keywords: [],
  ...over,
});

const comment = (
  over: Partial<ReviewComment> & Pick<ReviewComment, 'file' | 'line'>,
): ReviewComment => ({
  side: 'RIGHT',
  severity: 'critical',
  confidence: 'high',
  body: 'issue (blocking): something',
  ...over,
});

const groundTruth: PlantedBug[] = [
  bug({ file: 'src/a.ts', line: 10, id: 'a', severity: 'critical' }),
  bug({ file: 'src/b.ts', line: 20, id: 'b', severity: 'warn' }),
];

describe('scoreReview', () => {
  it('scores perfect detection as recall 1 / precision 1', () => {
    const result = scoreReview({
      groundTruth,
      comments: [
        comment({ file: 'src/a.ts', line: 10 }),
        comment({ file: 'src/b.ts', line: 20, severity: 'warn' }),
      ],
    });
    expect(result.recall).toBe(1);
    expect(result.recallSevere).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.falsePositives).toBe(0);
  });

  it('matches within the line tolerance but not beyond it', () => {
    const within = scoreReview({
      groundTruth,
      comments: [comment({ file: 'src/a.ts', line: 12 })], // +2, within default 3
    });
    expect(within.perBug.find((b) => b.bug.id === 'a')?.detected).toBe(true);

    const beyond = scoreReview({
      groundTruth,
      comments: [comment({ file: 'src/a.ts', line: 20 })], // +10, beyond tolerance
    });
    expect(beyond.perBug.find((b) => b.bug.id === 'a')?.detected).toBe(false);
  });

  it('counts info-level hits as detected but not detectedSevere', () => {
    const result = scoreReview({
      groundTruth,
      comments: [comment({ file: 'src/a.ts', line: 10, severity: 'info' })],
    });
    const a = result.perBug.find((b) => b.bug.id === 'a')!;
    expect(a.detected).toBe(true);
    expect(a.detectedSevere).toBe(false);
    expect(result.detected).toBe(1);
    expect(result.detectedSevere).toBe(0);
  });

  it('penalises off-target severe findings as false positives', () => {
    const result = scoreReview({
      groundTruth,
      comments: [
        comment({ file: 'src/a.ts', line: 10 }), // matches bug a
        comment({ file: 'src/noise.ts', line: 5 }), // false positive
      ],
    });
    expect(result.severeFindings).toBe(2);
    expect(result.matchedSevereFindings).toBe(1);
    expect(result.precision).toBe(0.5);
    expect(result.falsePositives).toBe(1);
  });

  it('reports precision null when there are no severe findings', () => {
    const result = scoreReview({
      groundTruth,
      comments: [comment({ file: 'src/a.ts', line: 10, severity: 'info' })],
    });
    expect(result.precision).toBeNull();
  });

  it('computes read-coverage from resolved source paths', () => {
    const result = scoreReview({
      groundTruth,
      comments: [],
      allFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      filesReadSource: ['src/a.ts', 'src/c.ts'],
    });
    expect(result.readCoverage).toEqual({
      filesReadCount: 2,
      allFilesCount: 4,
      coverage: 0.5,
      bugFilesRead: 1, // only src/a.ts of the two bug files
      bugFilesTotal: 2,
      bugFileCoverage: 0.5,
    });
  });
});
