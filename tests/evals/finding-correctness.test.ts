import { describe, expect, it } from 'vitest';
import {
  buildCorrectnessSystemPrompt,
  buildCorrectnessUserPrompt,
  judgeConsensus,
  parseJudgement,
  type Judgement,
} from './finding-correctness.js';

const judgement = (over: Partial<Judgement> = {}): Judgement => ({
  label: 'TRUE',
  preExisting: false,
  trigger: 'config.binary === false',
  reason: 'the guard is truthiness-based',
  ...over,
});

describe('buildCorrectnessSystemPrompt', () => {
  it('embeds the diff and demands a bare JSON object', () => {
    const prompt = buildCorrectnessSystemPrompt('diff --git a/a.ts b/a.ts\n+const x = 1;');
    expect(prompt).toContain('const x = 1;');
    expect(prompt).toContain('EXACTLY one JSON object');
    expect(prompt).toContain('"pre_existing"');
  });

  it('asks whether the diff introduced the behaviour', () => {
    // The failure that broke the first run was findings blaming a diff for
    // behaviour that predates it, so this question must survive prompt edits.
    expect(buildCorrectnessSystemPrompt('x')).toContain('already behave that way before');
  });

  it('clamps an oversized diff', () => {
    expect(buildCorrectnessSystemPrompt('x'.repeat(30_000))).toContain('…[truncated]');
  });
});

describe('buildCorrectnessUserPrompt', () => {
  it('states the finding location, severity and body', () => {
    const prompt = buildCorrectnessUserPrompt({
      file: 'src/a.ts',
      line: 7,
      severity: 'warn',
      body: 'Truthiness check drops falsy config.',
    });
    expect(prompt).toContain('File: src/a.ts:7');
    expect(prompt).toContain('Severity: WARN');
    expect(prompt).toContain('Truthiness check drops falsy config.');
  });
});

describe('parseJudgement', () => {
  it('reads a bare JSON object', () => {
    const parsed = parseJudgement(
      '{"label":"FALSE","pre_existing":true,"trigger":"","reason":"unchanged by the diff"}',
    );
    expect(parsed).toEqual({
      label: 'FALSE',
      preExisting: true,
      trigger: '',
      reason: 'unchanged by the diff',
    });
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const parsed = parseJudgement(
      'Here is my answer:\n```json\n{"label":"TRUE","pre_existing":false,"trigger":"empty input","reason":"ok"}\n```',
    );
    expect(parsed.label).toBe('TRUE');
    expect(parsed.trigger).toBe('empty input');
  });

  it('normalises label case', () => {
    expect(parseJudgement('{"label":"true","pre_existing":false}').label).toBe('TRUE');
  });

  it('defaults pre_existing to false rather than throwing when absent', () => {
    expect(parseJudgement('{"label":"UNPROVABLE"}').preExisting).toBe(false);
  });

  it('treats a non-boolean pre_existing as false instead of coercing a string', () => {
    // "false" is truthy in JS; a loose check would flip the meaning.
    expect(parseJudgement('{"label":"TRUE","pre_existing":"false"}').preExisting).toBe(false);
  });

  it('throws on missing JSON and on an unknown label', () => {
    expect(() => parseJudgement('no json here')).toThrow(/no JSON object/);
    expect(() => parseJudgement('{"label":"MAYBE"}')).toThrow(/unknown correctness label/);
  });
});

describe('judgeConsensus', () => {
  it('keeps a label when every sample agrees', () => {
    const result = judgeConsensus([judgement(), judgement({ reason: 'different wording' })]);
    expect(result.agreed).toBe(true);
    expect(result.label).toBe('TRUE');
  });

  it('returns no label on a split vote rather than taking a majority', () => {
    const result = judgeConsensus([
      judgement({ label: 'TRUE' }),
      judgement({ label: 'FALSE' }),
      judgement({ label: 'FALSE' }),
    ]);
    // A 2-1 split is a coin flip, not ground truth — the eval must exclude it.
    expect(result.agreed).toBe(false);
    expect(result.label).toBeNull();
  });

  it('takes the majority view of pre_existing', () => {
    expect(
      judgeConsensus([judgement({ preExisting: true }), judgement({ preExisting: true })])
        .preExisting,
    ).toBe(true);
    expect(
      judgeConsensus([judgement({ preExisting: true }), judgement({ preExisting: false })])
        .preExisting,
    ).toBe(false);
  });

  it('reports no label when every sample failed', () => {
    const result = judgeConsensus([]);
    expect(result.label).toBeNull();
    expect(result.agreed).toBe(false);
  });
});
