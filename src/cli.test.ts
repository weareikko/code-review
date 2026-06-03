import { describe, expect, it } from 'vitest';
import { countPostedBySeverity, formatUsageLine } from './cli.js';
import type { ReviewUsage } from './gitlab-review.js';
import type { GeneratedComment, Severity } from './types.js';

function makeComment(severity: Severity, duplicate = false): GeneratedComment {
  return {
    comment: { file: 'a.ts', line: 1, side: 'RIGHT', severity, confidence: 'high', body: 'x' },
    fingerprints: { primary: 'p', secondary: 's' },
    duplicate,
    payload: {
      body: '',
      position: {
        position_type: 'text',
        base_sha: '',
        start_sha: '',
        head_sha: '',
        old_path: '',
        new_path: '',
      },
    },
  };
}

function makeUsage(overrides: Partial<ReviewUsage['tokens']> = {}): ReviewUsage {
  return {
    model: 'anthropic/claude-sonnet-4-5',
    tokens: {
      input: overrides.input ?? 0,
      output: overrides.output ?? 0,
      cacheRead: overrides.cacheRead ?? 0,
      cacheWrite: overrides.cacheWrite ?? 0,
      total: overrides.total ?? 0,
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0533 },
    skills: [],
  };
}

describe('formatUsageLine', () => {
  it('sums input, cacheRead, and cacheWrite as billable input volume', () => {
    const usage = makeUsage({ input: 35, cacheRead: 10000, cacheWrite: 298, output: 1476 });
    const line = formatUsageLine(usage);
    expect(line).toBe(
      'Review usage: 10,333 in (10,000 cached) / 1,476 out tokens — $0.0533 (anthropic/claude-sonnet-4-5)',
    );
  });

  it('omits the cached hint when cacheRead is zero', () => {
    const usage = makeUsage({ input: 200, output: 50 });
    expect(formatUsageLine(usage)).toBe(
      'Review usage: 200 in / 50 out tokens — $0.0533 (anthropic/claude-sonnet-4-5)',
    );
  });

  it('still counts cacheWrite when cacheRead is zero', () => {
    const usage = makeUsage({ input: 100, cacheWrite: 500, output: 25 });
    expect(formatUsageLine(usage)).toBe(
      'Review usage: 600 in / 25 out tokens — $0.0533 (anthropic/claude-sonnet-4-5)',
    );
  });
});

describe('countPostedBySeverity', () => {
  it('counts only non-duplicate comments, grouped by severity', () => {
    const generated = [
      makeComment('critical'),
      makeComment('critical'),
      makeComment('warn'),
      makeComment('info'),
      makeComment('info', true), // duplicate — not posted, excluded
    ];
    expect(countPostedBySeverity(generated)).toEqual({ critical: 2, warn: 1, info: 1 });
  });

  it('returns an empty object when every comment is a duplicate', () => {
    expect(countPostedBySeverity([makeComment('warn', true)])).toEqual({});
  });
});
