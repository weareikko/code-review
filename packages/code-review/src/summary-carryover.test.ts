import { describe, expect, it } from 'vitest';
import type { Discussion } from './gitlab.js';
import {
  applyCarryOverToSummary,
  type CarryOverFinding,
  extractOpenBotFindings,
  selectCarryOver,
  withCarriedOverFindings,
} from './summary-carryover.js';

// Fingerprint hashes must be hex ([a-f0-9]) to match the marker pattern.
function markers(primary: string, secondary: string): string {
  return `<!-- gitlab-review:fingerprint-primary:${primary} -->\n<!-- gitlab-review:fingerprint-secondary:${secondary} -->`;
}

function botFinding(opts: {
  file: string;
  line: number;
  header: string;
  subject: string;
  primary: string;
  secondary: string;
  resolved?: boolean;
}): Discussion {
  return {
    notes: [
      {
        body: `${opts.header}: ${opts.subject}\n\nDiscussion.\n\n${markers(opts.primary, opts.secondary)}`,
        resolved: opts.resolved ?? false,
        position: { new_path: opts.file, new_line: opts.line },
      },
    ],
  } as Discussion;
}

describe('extractOpenBotFindings', () => {
  it('extracts open bot findings with severity decoded from the header', () => {
    const discussions = [
      botFinding({
        file: 'src/a.ts',
        line: 10,
        header: 'issue (blocking)',
        subject: 'Null deref',
        primary: 'a1',
        secondary: 'b1',
      }),
      botFinding({
        file: 'src/b.ts',
        line: 5,
        header: 'issue',
        subject: 'Wrong default',
        primary: 'a2',
        secondary: 'b2',
      }),
      botFinding({
        file: 'src/c.ts',
        line: 2,
        header: 'nitpick',
        subject: 'rename',
        primary: 'a3',
        secondary: 'b3',
      }),
    ];
    const out = extractOpenBotFindings(discussions);
    expect(out.map((f) => f.severity)).toEqual(['critical', 'warn', 'info']);
    expect(out[0]).toMatchObject({ file: 'src/a.ts', line: 10, header: 'issue (blocking)' });
    expect(out[0].hashes.sort()).toEqual(['a1', 'b1']);
  });

  it('skips resolved threads, non-positional notes, and notes without fingerprints', () => {
    const resolved = botFinding({
      file: 'src/a.ts',
      line: 1,
      header: 'issue',
      subject: 'x',
      primary: 'aa',
      secondary: 'bb',
      resolved: true,
    });
    const summaryNote = {
      notes: [{ body: 'plain summary, no markers, no position' }],
    } as Discussion;
    const noFingerprint = {
      notes: [{ body: 'issue: hi', position: { new_path: 'src/x.ts', new_line: 3 } }],
    } as Discussion;
    expect(extractOpenBotFindings([resolved, summaryNote, noFingerprint])).toEqual([]);
  });
});

describe('selectCarryOver', () => {
  const open: CarryOverFinding[] = [
    { file: 'a', line: 1, severity: 'warn', header: 'issue', subject: 'x', hashes: ['a1', 'b1'] },
    { file: 'b', line: 2, severity: 'warn', header: 'issue', subject: 'y', hashes: ['a2', 'b2'] },
  ];

  it('drops findings the current run re-emitted (any fingerprint match)', () => {
    const current = new Set(['b1']); // matches the first finding's secondary
    expect(selectCarryOver(open, current).map((f) => f.file)).toEqual(['b']);
  });

  it('keeps all when the current run re-emitted none', () => {
    expect(selectCarryOver(open, new Set()).length).toBe(2);
  });
});

describe('applyCarryOverToSummary', () => {
  const carryCritical: CarryOverFinding[] = [
    {
      file: 'src/a.ts',
      line: 10,
      severity: 'critical',
      header: 'issue (blocking)',
      subject: 'Null deref',
      hashes: ['a1', 'b1'],
    },
  ];

  it('returns the summary unchanged when there is nothing to carry over', () => {
    const summary = '**Risk: Low** — fine.';
    expect(applyCarryOverToSummary(summary, [])).toBe(summary);
  });

  it('bumps the risk line up to match a carried-over finding', () => {
    const out = applyCarryOverToSummary('**Risk: Low** — nothing new this run.', carryCritical);
    expect(out).toMatch(/^\*\*Risk: High\*\*/);
    expect(out).toContain('**Still open from earlier reviews (1 finding):**');
    expect(out).toContain('**issue (blocking)** — `src/a.ts:10` — Null deref');
  });

  it('never lowers the risk line', () => {
    const carryInfo: CarryOverFinding[] = [
      { file: 'x', line: 1, severity: 'info', header: 'note', subject: 'n', hashes: ['ff'] },
    ];
    const out = applyCarryOverToSummary('**Risk: High** — blocking issue remains.', carryInfo);
    expect(out).toMatch(/^\*\*Risk: High\*\*/);
  });
});

describe('withCarriedOverFindings (end to end)', () => {
  it('retains a still-open prior finding the current run did not re-emit', () => {
    // Run 2 emitted nothing (empty fingerprint set); a prior open CRITICAL thread
    // must not vanish from the summary, and risk must reflect it.
    const discussions = [
      botFinding({
        file: 'src/pay.ts',
        line: 42,
        header: 'issue (blocking)',
        subject: 'Overcharge on retry',
        primary: 'a1',
        secondary: 'b1',
      }),
    ];
    const summary = '**Risk: Low** — no issues found this run.';
    const out = withCarriedOverFindings(summary, discussions, new Set());
    expect(out).toMatch(/^\*\*Risk: High\*\*/);
    expect(out).toContain('`src/pay.ts:42` — Overcharge on retry');
  });

  it('does not re-list a prior finding the current run re-emitted', () => {
    const discussions = [
      botFinding({
        file: 'src/pay.ts',
        line: 42,
        header: 'issue (blocking)',
        subject: 'Overcharge on retry',
        primary: 'a1',
        secondary: 'b1',
      }),
    ];
    const summary = '**Risk: High** — one issue found.';
    // Current run re-emitted it (secondary fingerprint present) → no carry-over.
    const out = withCarriedOverFindings(summary, discussions, new Set(['b1']));
    expect(out).toBe(summary);
  });
});
