import { describe, expect, it } from 'vitest';
import {
  countPostedBySeverity,
  formatPerModelUsage,
  formatUsageLine,
  withHttpStamping,
} from './cli.js';
import type { DiagnosticContext } from './diagnostics.js';
import type { ReviewUsage } from './gitlab-review.js';
import type { GitLabResponseInfo } from './gitlab.js';
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

describe('withHttpStamping', () => {
  const response: GitLabResponseInfo = {
    method: 'POST',
    path: '/draft_notes/bulk_publish',
    url: 'https://gitlab.example.com/api/v4/projects/1/merge_requests/2/draft_notes/bulk_publish',
    status: 500,
  };

  function emptyContext(): DiagnosticContext {
    return { phase: 'gitlab.post_comments' } as DiagnosticContext;
  }

  it('stamps HTTP attributes when the wrapped operation throws (e.g. a 500 on bulk_publish)', async () => {
    let last: GitLabResponseInfo | undefined;
    const wrapped = withHttpStamping(
      () => last,
      async () => {
        // The failing request reports its response before the error is thrown.
        last = response;
        throw new Error('bulk_publish 500');
      },
    );
    const context = emptyContext();
    await expect(wrapped(context)).rejects.toThrow('bulk_publish 500');
    expect(context.httpRequestMethod).toBe('POST');
    expect(context.httpStatusCode).toBe(500);
    expect(context.httpUrl).toBe(response.url);
    expect(context.serverAddress).toBe('gitlab.example.com');
  });

  it('stamps HTTP attributes on the success path too', async () => {
    let last: GitLabResponseInfo | undefined;
    const wrapped = withHttpStamping(
      () => last,
      async () => {
        last = { ...response, status: 204 };
        return 'ok';
      },
    );
    const context = emptyContext();
    await expect(wrapped(context)).resolves.toBe('ok');
    expect(context.httpStatusCode).toBe(204);
  });

  it('does not inherit a previous phase response when this phase made no request', async () => {
    const stale = response;
    const wrapped = withHttpStamping(
      () => stale,
      async () => 'ok',
    );
    const context = emptyContext();
    await wrapped(context);
    expect(context.httpStatusCode).toBeUndefined();
    expect(context.httpUrl).toBeUndefined();
  });
});

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

function zeroBreakdown() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

describe('formatPerModelUsage', () => {
  it('returns undefined when there is no per-model breakdown', () => {
    expect(formatPerModelUsage(makeUsage())).toBeUndefined();
  });

  it('renders one line per model with token totals and cost', () => {
    const usage: ReviewUsage = {
      ...makeUsage(),
      byModel: [
        {
          model: 'anthropic/claude-sonnet-4-5',
          tokens: { ...zeroBreakdown(), input: 1000, output: 200, total: 1200 },
          cost: { ...zeroBreakdown(), total: 0.04 },
        },
        {
          model: 'google/gemini-2.5-pro',
          tokens: { ...zeroBreakdown(), input: 500, output: 100, total: 600 },
          cost: { ...zeroBreakdown(), total: 0.0133 },
        },
      ],
    };
    const out = formatPerModelUsage(usage);
    expect(out).toBeDefined();
    expect(out).toContain('anthropic/claude-sonnet-4-5');
    expect(out).toContain('google/gemini-2.5-pro');
    expect(out).toContain('$0.0400');
    expect(out).toContain('$0.0133');
    // never leak keys — only model ids and numbers
    expect(out).not.toMatch(/key/i);
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
