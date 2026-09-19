import { describe, expect, it } from 'vitest';
import {
  buildJevVerifyState,
  parseJevVerdict,
  JEV_MAX_DIFF_CHARS,
  VERIFY_CRITERIA,
  VERIFY_QUESTIONS,
  type JevResponse,
} from './jev.js';

const baseInput = {
  diff: 'diff --git a/a.ts b/a.ts\n+const x = 1;',
  file: 'src/a.ts',
  line: 42,
  severity: 'critical',
  confidence: 'high',
  body: 'Null dereference on the happy path.',
};

function response(answers: JevResponse['answers']): JevResponse {
  return {
    model: 'typesafe/jev-1.13-20260917',
    answers,
    usage: { input_tokens: 10, output_tokens: 0, cost: 0 },
    id: 'gen-dec-test',
    provider: 'TypeSafe',
  };
}

describe('VERIFY_CRITERIA', () => {
  it('offers exactly the three VerifyDecision options the Verify stage applies', () => {
    expect(Object.keys(VERIFY_CRITERIA).toSorted()).toEqual(['downgrade', 'drop', 'keep']);
  });

  it('asks both the verdict choice and the demonstrability gate', () => {
    expect(VERIFY_QUESTIONS.verdict.type).toBe('choice');
    expect(VERIFY_QUESTIONS.demonstrable.type).toBe('noul');
  });
});

describe('buildJevVerifyState', () => {
  it('carries the diff and the finding, and reports no clamp for a small diff', () => {
    const { state, clamped } = buildJevVerifyState(baseInput);
    expect(clamped).toBe(false);
    expect(state).toContain('<diff>');
    expect(state).toContain('const x = 1;');
    expect(state).toContain('File: src/a.ts:42');
    expect(state).toContain('Severity: CRITICAL (confidence: high)');
    expect(state).toContain('Null dereference on the happy path.');
  });

  it('omits the commit block when no commit log is given', () => {
    expect(buildJevVerifyState(baseInput).state).not.toContain('<commits>');
    expect(buildJevVerifyState({ ...baseInput, commitLog: '   ' }).state).not.toContain(
      '<commits>',
    );
  });

  it('includes the commit log when present', () => {
    const { state } = buildJevVerifyState({ ...baseInput, commitLog: 'fix: guard the lookup' });
    expect(state).toContain('<commits>\nfix: guard the lookup\n</commits>');
  });

  it('clamps an oversized diff and flags it, so a truncated run is never silent', () => {
    const { state, clamped } = buildJevVerifyState({
      ...baseInput,
      diff: 'x'.repeat(JEV_MAX_DIFF_CHARS + 100),
    });
    expect(clamped).toBe(true);
    expect(state).toContain('…[truncated]');
    // The finding must survive the clamp — it is appended after the diff.
    expect(state).toContain('File: src/a.ts:42');
  });
});

describe('parseJevVerdict', () => {
  it('reads the decision, confidence and demonstrability', () => {
    const parsed = parseJevVerdict(
      response({
        verdict: {
          type: 'choice',
          choice: 'drop',
          probabilities: { keep: 0.05, downgrade: 0.15, drop: 0.8 },
          confidence: 0.8,
        },
        demonstrable: { type: 'noul', noul: 0.12 },
      }),
    );
    expect(parsed.decision).toBe('drop');
    expect(parsed.confidence).toBe(0.8);
    expect(parsed.demonstrable).toBe(0.12);
    expect(parsed.probabilities.drop).toBe(0.8);
  });

  it('returns NaN demonstrability rather than 0 when the noul answer is missing', () => {
    const parsed = parseJevVerdict(
      response({
        verdict: { type: 'choice', choice: 'keep', probabilities: { keep: 1 }, confidence: 1 },
      }),
    );
    // 0 would read as "definitely not demonstrable" and silently skew the gate.
    expect(parsed.demonstrable).toBeNaN();
  });

  it('throws when the verdict answer is absent or not a choice', () => {
    expect(() => parseJevVerdict(response({}))).toThrow(/no choice answer/);
    expect(() => parseJevVerdict(response({ verdict: { type: 'noul', noul: 0.5 } }))).toThrow(
      /no choice answer/,
    );
  });

  it('throws on a decision outside the three the Verify stage can apply', () => {
    expect(() =>
      parseJevVerdict(
        response({
          verdict: { type: 'choice', choice: 'escalate', probabilities: {}, confidence: 1 },
        }),
      ),
    ).toThrow(/unknown decision: escalate/);
  });
});
