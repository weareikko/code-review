import { describe, expect, it } from 'vitest';
import { type AuthoredFinding, REVIEW_ANGLES, triageFindings } from './triage.js';
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

function f(overrides: Partial<ReviewComment> = {}, authorModel = 'anthropic/m'): AuthoredFinding {
  return { comment: c(overrides), authorModel };
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
      [f({ file: 'a.ts', line: 1, body: 'issue: bug one' })],
      [f({ file: 'b.ts', line: 2, body: 'issue: bug two' })],
    ]);
    expect(out).toHaveLength(2);
  });

  it('collapses the same finding raised by multiple angles', () => {
    const out = triageFindings([
      [f({ file: 'a.ts', line: 5, body: 'issue (blocking): Race on shared counter' })],
      [f({ file: 'a.ts', line: 5, body: 'issue: Race on shared counter' })],
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps the higher-severity copy when angles disagree on severity', () => {
    const out = triageFindings([
      [f({ file: 'a.ts', line: 5, severity: 'warn', body: 'issue: Race on shared counter' })],
      [
        f({
          file: 'a.ts',
          line: 5,
          severity: 'critical',
          body: 'issue (blocking): Race on shared counter',
        }),
      ],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].comment.severity).toBe('critical');
  });

  it('breaks severity ties by higher confidence', () => {
    const out = triageFindings([
      [f({ line: 7, severity: 'warn', confidence: 'low', body: 'issue: same thing' })],
      [f({ line: 7, severity: 'warn', confidence: 'high', body: 'issue: same thing' })],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].comment.confidence).toBe('high');
  });

  it('does not merge findings on the same line with different subjects', () => {
    const out = triageFindings([
      [f({ file: 'a.ts', line: 5, body: 'issue: race on counter' })],
      [f({ file: 'a.ts', line: 5, body: 'issue: missing null check' })],
    ]);
    expect(out).toHaveLength(2);
  });

  it('ignores label/punctuation differences when detecting duplicates', () => {
    const out = triageFindings([
      [f({ line: 9, body: 'issue (blocking): Cache is not keyed by user!' })],
      [f({ line: 9, body: 'issue: cache is not keyed by user' })],
    ]);
    expect(out).toHaveLength(1);
  });

  it('preserves the surviving finding’s author model', () => {
    const out = triageFindings([
      [
        f(
          { file: 'a.ts', line: 5, severity: 'warn', body: 'issue: Race on shared counter' },
          'anthropic/sonnet',
        ),
      ],
      [
        f(
          {
            file: 'a.ts',
            line: 5,
            severity: 'critical',
            body: 'issue (blocking): Race on shared counter',
          },
          'google/gemini',
        ),
      ],
    ]);
    expect(out).toHaveLength(1);
    // critical wins → its author (google/gemini) survives
    expect(out[0].authorModel).toBe('google/gemini');
  });

  describe('hardened fuzzy dedup', () => {
    it('merges near-duplicate phrasings from different models on a close line', () => {
      const out = triageFindings([
        [
          f(
            {
              file: 'a.ts',
              line: 40,
              severity: 'warn',
              body: 'issue: Unawaited promise in retry loop',
            },
            'anthropic/sonnet',
          ),
        ],
        [
          f(
            {
              file: 'a.ts',
              line: 42,
              severity: 'warn',
              body: 'issue: Promise in the retry loop is not awaited',
            },
            'google/gemini',
          ),
        ],
      ]);
      expect(out).toHaveLength(1);
    });

    it('does not over-merge genuinely distinct findings on adjacent lines', () => {
      const out = triageFindings([
        [f({ file: 'a.ts', line: 40, body: 'issue: Missing null check on user input' })],
        [f({ file: 'a.ts', line: 41, body: 'issue: SQL injection via raw query string' })],
      ]);
      expect(out).toHaveLength(2);
    });

    it('does not merge similar subjects in different files', () => {
      const out = triageFindings([
        [f({ file: 'a.ts', line: 40, body: 'issue: Unawaited promise in retry loop' })],
        [f({ file: 'b.ts', line: 40, body: 'issue: Unawaited promise in retry loop' })],
      ]);
      expect(out).toHaveLength(2);
    });

    it('is deterministic and order-independent under input reordering', () => {
      const a = f(
        {
          file: 'a.ts',
          line: 40,
          severity: 'warn',
          body: 'issue: Unawaited promise in retry loop',
        },
        'anthropic/sonnet',
      );
      const b = f(
        {
          file: 'a.ts',
          line: 42,
          severity: 'critical',
          body: 'issue (blocking): Promise in retry loop is not awaited',
        },
        'google/gemini',
      );
      const out1 = triageFindings([[a], [b]]);
      const out2 = triageFindings([[b], [a]]);
      expect(out1).toHaveLength(1);
      expect(out2).toEqual(out1);
      // critical wins regardless of order
      expect(out1[0].comment.severity).toBe('critical');
      expect(out1[0].authorModel).toBe('google/gemini');
    });
  });
});
