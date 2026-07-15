import { describe, expect, it } from 'vitest';
import {
  appendFingerprintMarkers,
  extractExistingFingerprints,
  fingerprints,
} from './fingerprints.js';
import type { ReviewComment } from './types.js';

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    file: 'src/index.ts',
    line: 10,
    side: 'RIGHT',
    severity: 'warn',
    confidence: 'high',
    body: 'Null check missing on user.email before .includes().',
    ...overrides,
  };
}

// Two "runs" of the same finding where the author edited nearby lines: the diff
// hunk grows/shifts, so the hunk context differs between runs even though the
// finding is unchanged.
const HUNK_RUN_1 = '@@ -1,3 +1,4 @@\n context\n+added line\n user.email.includes("@")';
const HUNK_RUN_2 =
  '@@ -1,5 +1,7 @@\n context\n+added line\n+another new line above\n+and another\n user.email.includes("@")';

describe('fingerprints (#91 edit-stable dedup)', () => {
  it('keeps the secondary fingerprint stable when the surrounding hunk changes', () => {
    const c = comment();
    const run1 = fingerprints(c, HUNK_RUN_1);
    const run2 = fingerprints(c, HUNK_RUN_2);
    // Edit-stable fallback: identical across runs despite the hunk changing.
    expect(run2.secondary).toBe(run1.secondary);
  });

  it('deduplicates a finding across a nearby-line edit via the secondary fingerprint', () => {
    // Reproduces the dedup check in payloads.ts: a finding is a duplicate when
    // EITHER fingerprint matches one already posted.
    const c = comment();
    const posted = fingerprints(c, HUNK_RUN_1);
    const seen = new Set([posted.primary, posted.secondary]);

    const rerun = fingerprints(c, HUNK_RUN_2);
    const isDuplicate = seen.has(rerun.primary) || seen.has(rerun.secondary);
    expect(isDuplicate).toBe(true);
  });

  it('still shifts the primary fingerprint when the hunk changes (exact match only)', () => {
    const c = comment();
    expect(fingerprints(c, HUNK_RUN_2).primary).not.toBe(fingerprints(c, HUNK_RUN_1).primary);
  });

  it('distinguishes different findings on the same file/side (no false dedup)', () => {
    const a = fingerprints(comment({ body: 'Null check missing on user.email.' }), HUNK_RUN_1);
    const b = fingerprints(comment({ body: 'Off-by-one in the retry loop.' }), HUNK_RUN_1);
    expect(b.secondary).not.toBe(a.secondary);
    expect(b.primary).not.toBe(a.primary);
  });

  it('separates the same body across different files and sides', () => {
    const base = comment();
    const otherFile = fingerprints(comment({ file: 'src/other.ts' }), HUNK_RUN_1);
    const otherSide = fingerprints(comment({ side: 'LEFT' }), HUNK_RUN_1);
    const ref = fingerprints(base, HUNK_RUN_1);
    expect(otherFile.secondary).not.toBe(ref.secondary);
    expect(otherSide.secondary).not.toBe(ref.secondary);
  });
});

describe('fingerprint markers (code-review rename migration)', () => {
  const fp = { primary: 'aaaa1111', secondary: 'bbbb2222' };

  it('writes markers under the current code-review prefix', () => {
    const body = appendFingerprintMarkers('A finding.', fp);
    expect(body).toContain(`<!-- code-review:fingerprint-primary:${fp.primary} -->`);
    expect(body).toContain(`<!-- code-review:fingerprint-secondary:${fp.secondary} -->`);
    expect(body).not.toContain('gitlab-review:fingerprint');
  });

  it('extracts markers written under the current code-review prefix', () => {
    const body = appendFingerprintMarkers('A finding.', fp);
    const set = extractExistingFingerprints([{ notes: [{ id: 1, body }] }]);
    expect(set.has(fp.primary)).toBe(true);
    expect(set.has(fp.secondary)).toBe(true);
  });

  // Migration guard: findings posted under the former `gitlab-review` identity
  // must still be recognised so dedup keeps working across the rename.
  it('still extracts markers written under the legacy gitlab-review prefix', () => {
    const legacyBody =
      'A finding.\n\n<!-- gitlab-review:fingerprint-primary:cafe -->\n<!-- gitlab-review:fingerprint-secondary:f00d -->';
    const set = extractExistingFingerprints([{ notes: [{ id: 1, body: legacyBody }] }]);
    expect(set.has('cafe')).toBe(true);
    expect(set.has('f00d')).toBe(true);
  });
});
