import { describe, expect, it } from 'vitest';
import type { ReviewComment } from './types.js';
import {
  applyVerdicts,
  parseVerdict,
  rebuildSummary,
  relabelBodyHeader,
  stepDownSeverity,
  synthesizeReviewJson,
  type Verdict,
} from './verify.js';

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    file: 'src/a.ts',
    line: 10,
    side: 'RIGHT',
    severity: 'critical',
    confidence: 'high',
    body: 'issue (blocking): Off-by-one in retry loop\n\nThe loop runs N+1 times.',
    ...overrides,
  };
}

describe('parseVerdict', () => {
  it('parses a bare JSON verdict', () => {
    expect(parseVerdict('{"decision":"drop","reason":"not reachable"}')).toEqual({
      decision: 'drop',
      reason: 'not reachable',
    });
  });

  it('parses a fenced JSON verdict surrounded by prose', () => {
    const text =
      'Here is my verdict:\n```json\n{"decision":"downgrade","reason":"smell only"}\n```\n';
    expect(parseVerdict(text)).toEqual({ decision: 'downgrade', reason: 'smell only' });
  });

  it('defaults to keep when the output is not parseable', () => {
    expect(parseVerdict('no json here').decision).toBe('keep');
    expect(parseVerdict('{not valid}').decision).toBe('keep');
  });

  it('defaults an unknown decision value to keep', () => {
    expect(parseVerdict('{"decision":"maybe","reason":"unsure"}').decision).toBe('keep');
  });

  it('supplies a fallback reason when none is given', () => {
    expect(parseVerdict('{"decision":"drop"}').reason).toBe('no reason given');
  });
});

describe('stepDownSeverity', () => {
  it('lowers severity one tier and floors at info', () => {
    expect(stepDownSeverity('critical')).toBe('warn');
    expect(stepDownSeverity('warn')).toBe('info');
    expect(stepDownSeverity('info')).toBe('info');
  });
});

describe('relabelBodyHeader', () => {
  it('rewrites the conventional header to match the new severity', () => {
    const body = 'issue (blocking): Boom\n\nDetails.';
    expect(relabelBodyHeader(body, 'warn')).toBe('issue: Boom\n\nDetails.');
    expect(relabelBodyHeader(body, 'info')).toBe('note: Boom\n\nDetails.');
  });

  it('leaves a body without a recognizable header untouched', () => {
    const body = 'No header here\nsecond line';
    expect(relabelBodyHeader(body, 'warn')).toBe(body);
  });
});

describe('applyVerdicts', () => {
  it('keeps a finding with no verdict (e.g. INFO) unchanged', () => {
    const info = comment({ severity: 'info', body: 'nitpick: rename x' });
    const { comments, audit } = applyVerdicts([info], new Map());
    expect(comments).toEqual([info]);
    expect(audit).toEqual([]);
  });

  it('keeps a confirmed finding unchanged', () => {
    const c = comment();
    const verdicts = new Map<number, Verdict>([[0, { decision: 'keep', reason: 'proven' }]]);
    const { comments, audit } = applyVerdicts([c], verdicts);
    expect(comments).toEqual([c]);
    expect(audit).toEqual([]);
  });

  it('drops a refuted finding and records it in the audit', () => {
    const c = comment();
    const verdicts = new Map<number, Verdict>([[0, { decision: 'drop', reason: 'not reachable' }]]);
    const { comments, audit } = applyVerdicts([c], verdicts);
    expect(comments).toEqual([]);
    expect(audit).toEqual([
      {
        file: 'src/a.ts',
        line: 10,
        action: 'dropped',
        fromSeverity: 'critical',
        reason: 'not reachable',
      },
    ]);
  });

  it('downgrades a finding, relabels its header, and records the audit', () => {
    const c = comment();
    const verdicts = new Map<number, Verdict>([
      [0, { decision: 'downgrade', reason: 'failure path unproven' }],
    ]);
    const { comments, audit } = applyVerdicts([c], verdicts);
    expect(comments).toHaveLength(1);
    expect(comments[0].severity).toBe('warn');
    expect(comments[0].body.split('\n', 1)[0]).toBe('issue: Off-by-one in retry loop');
    expect(audit[0]).toMatchObject({
      action: 'downgraded',
      fromSeverity: 'critical',
      toSeverity: 'warn',
    });
  });
});

describe('rebuildSummary', () => {
  const original =
    '**Risk: High** — do not merge until the off-by-one is fixed.\n\n' +
    'Adds a checkout retry helper used by the cart route.\n\n' +
    '**1 issue found:**\n- **issue (blocking)** — `src/a.ts:10` — Off-by-one in retry loop';

  it('recomputes risk to Low and drops the issues block when nothing survives', () => {
    const summary = rebuildSummary(
      original,
      [],
      [
        {
          file: 'src/a.ts',
          line: 10,
          action: 'dropped',
          fromSeverity: 'critical',
          reason: 'not reachable',
        },
      ],
    );
    expect(summary).toMatch(/^\*\*Risk: Low\*\*/);
    expect(summary).not.toMatch(/issue.*found/i);
    // Overview prose is preserved.
    expect(summary).toContain('Adds a checkout retry helper');
    // The drop is auditable in the Notes section.
    expect(summary).toContain('**Notes:**');
    expect(summary).toContain('Verify removed a CRITICAL finding at `src/a.ts:10`');
  });

  it('regenerates the issues block from the surviving comments', () => {
    const survivor = comment({ severity: 'warn', body: 'issue: Off-by-one in retry loop\n\nx' });
    const summary = rebuildSummary(
      original,
      [survivor],
      [
        {
          file: 'src/a.ts',
          line: 10,
          action: 'downgraded',
          fromSeverity: 'critical',
          toSeverity: 'warn',
          reason: 'failure path unproven',
        },
      ],
    );
    expect(summary).toMatch(/^\*\*Risk: Medium\*\*/);
    expect(summary).toMatch(/\*\*1 issue found:\*\*/);
    expect(summary).toContain('`src/a.ts:10`');
  });
});

describe('synthesizeReviewJson', () => {
  it('emits parseable { summary, comments } JSON', () => {
    const survivor = comment({ severity: 'warn' });
    const json = synthesizeReviewJson('**Risk: High** — x\n\noverview', {
      comments: [survivor],
      audit: [],
    });
    const parsed = JSON.parse(json) as { summary: string; comments: ReviewComment[] };
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.summary).toMatch(/^\*\*Risk: Medium\*\*/);
  });
});
