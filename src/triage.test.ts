import { describe, expect, it } from 'vitest';
import { REVIEW_ANGLES, triageFindings } from './triage.js';
import type { ReviewComment } from './types.js';

function c(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    file: 'src/a.ts',
    line: 10,
    side: 'RIGHT',
    severity: 'warn',
    confidence: 'medium',
    body: 'issue: Off-by-one in retry loop\n\ndetails',
    ...overrides,
  };
}

describe('REVIEW_ANGLES', () => {
  it('exposes distinct, non-empty angle keys', () => {
    const keys = REVIEW_ANGLES.map((a) => a.key);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of REVIEW_ANGLES) expect(a.directive.length).toBeGreaterThan(20);
  });
});

describe('triageFindings', () => {
  it('returns all findings when there are no duplicates', () => {
    const out = triageFindings([
      [c({ file: 'a.ts', line: 1, body: 'issue: bug one' })],
      [c({ file: 'b.ts', line: 2, body: 'issue: bug two' })],
    ]);
    expect(out).toHaveLength(2);
  });

  it('collapses the same finding raised by multiple angles', () => {
    const out = triageFindings([
      [c({ file: 'a.ts', line: 5, body: 'issue (blocking): Race on shared counter' })],
      [c({ file: 'a.ts', line: 5, body: 'issue: Race on shared counter' })],
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps the higher-severity copy when angles disagree on severity', () => {
    const out = triageFindings([
      [c({ file: 'a.ts', line: 5, severity: 'warn', body: 'issue: Race on shared counter' })],
      [
        c({
          file: 'a.ts',
          line: 5,
          severity: 'critical',
          body: 'issue (blocking): Race on shared counter',
        }),
      ],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('critical');
  });

  it('breaks severity ties by higher confidence', () => {
    const out = triageFindings([
      [c({ line: 7, severity: 'warn', confidence: 'low', body: 'issue: same thing' })],
      [c({ line: 7, severity: 'warn', confidence: 'high', body: 'issue: same thing' })],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('high');
  });

  it('does not merge findings on the same line with different subjects', () => {
    const out = triageFindings([
      [c({ file: 'a.ts', line: 5, body: 'issue: race on counter' })],
      [c({ file: 'a.ts', line: 5, body: 'issue: missing null check' })],
    ]);
    expect(out).toHaveLength(2);
  });

  it('ignores label/punctuation differences when detecting duplicates', () => {
    const out = triageFindings([
      [c({ line: 9, body: 'issue (blocking): Cache is not keyed by user!' })],
      [c({ line: 9, body: 'issue: cache is not keyed by user' })],
    ]);
    expect(out).toHaveLength(1);
  });
});
