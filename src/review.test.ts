import { describe, expect, it } from 'vitest';
import {
  appendFingerprintMarkers,
  buildGeneratedComments,
  buildPayload,
  extractDiffHunkContext,
  extractExistingFingerprints,
  fingerprints,
  normalizeBody,
} from './review.js';

describe('diff hunk context', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' line1',
    '-line2',
    '+line2-updated',
    ' line3',
    '@@ -10,2 +11,3 @@',
    ' line10',
    '+line11-new',
    ' line12',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -4,2 +4,2 @@',
    '-old-b',
    '+new-b',
  ].join('\n');

  it('returns the matching hunk for right-side lines', () => {
    const hunk = extractDiffHunkContext(diff, 'src/a.ts', 11, 'RIGHT');
    expect(hunk).toContain('@@ -10,2 +11,3 @@');
    expect(hunk).toContain('+line11-new');
  });

  it('returns the matching hunk for left-side lines', () => {
    const hunk = extractDiffHunkContext(diff, 'src/a.ts', 2, 'LEFT');
    expect(hunk).toContain('@@ -1,3 +1,4 @@');
    expect(hunk).toContain('-line2');
  });

  it('returns deterministic fallback when no matching hunk exists', () => {
    expect(extractDiffHunkContext(diff, 'src/unknown.ts', 1, 'RIGHT')).toBe(
      'src/unknown.ts:RIGHT:1',
    );
  });
});

describe('fingerprints and duplicate detection', () => {
  it('normalizes comment bodies consistently', () => {
    const a = 'Fix   this\n\n<!-- gitlab-review:fingerprint-primary:abcd -->';
    const b = 'Fix this';

    expect(normalizeBody(a)).toBe(normalizeBody(b));
  });

  it('produces stable fingerprints for semantically same bodies', () => {
    const comment = {
      file: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      severity: 'info' as const,
      body: 'Fix   this',
    };
    const sameComment = { ...comment, body: 'Fix this' };

    expect(fingerprints(comment, 'hunk-context')).toEqual(
      fingerprints(sameComment, 'hunk-context'),
    );
  });

  it('changes fingerprints when hunk context changes', () => {
    const comment = {
      file: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      severity: 'info' as const,
      body: 'Fix this',
    };
    const fpA = fingerprints(comment, 'hunk-a');
    const fpB = fingerprints(comment, 'hunk-b');

    expect(fpA.primary).not.toBe(fpB.primary);
    expect(fpA.secondary).not.toBe(fpB.secondary);
  });

  it('extracts existing markers and marks generated duplicates', () => {
    const baseComment = {
      file: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      severity: 'info' as const,
      body: 'Please rename this variable',
    };
    const hunk = '@@ -1,1 +1,2 @@\n old\n+new';
    const existing = fingerprints(baseComment, hunk);
    const existingSet = extractExistingFingerprints([
      { notes: [{ body: appendFingerprintMarkers('Existing', existing) }] },
    ]);

    const generated = buildGeneratedComments(
      [baseComment, baseComment],
      ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', hunk].join('\n'),
      { base_sha: 'base', start_sha: 'start', head_sha: 'head' },
      existingSet,
    );

    expect(generated).toHaveLength(2);
    expect(generated[0].duplicate).toBe(true);
    expect(generated[1].duplicate).toBe(true);
  });
});

describe('payload generation', () => {
  const refs = { base_sha: 'base', start_sha: 'start', head_sha: 'head' };

  it('builds right-side payloads with new_line', () => {
    const payload = buildPayload(
      { file: 'src/file.ts', line: 42, side: 'RIGHT', severity: 'info', body: 'Body' },
      'Body',
      refs,
    );

    expect(payload).toEqual({
      body: 'Body',
      position: {
        position_type: 'text',
        base_sha: 'base',
        start_sha: 'start',
        head_sha: 'head',
        old_path: 'src/file.ts',
        new_path: 'src/file.ts',
        new_line: 42,
      },
    });
  });

  it('builds left-side payloads with old_line', () => {
    const payload = buildPayload(
      { file: 'src/file.ts', line: 5, side: 'LEFT', severity: 'warn', body: 'Body' },
      'Body',
      refs,
    );

    expect(payload.position).toMatchObject({
      old_path: 'src/file.ts',
      new_path: 'src/file.ts',
      old_line: 5,
    });
    expect(payload.position.new_line).toBeUndefined();
  });
});
