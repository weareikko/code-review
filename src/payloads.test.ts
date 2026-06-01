import { describe, expect, it } from 'vitest';
import { buildCommentBody, buildGeneratedComments } from './payloads.js';
import type { DiffRefs, ReviewComment } from './types.js';

declare const __PKG_VERSION__: string;

const COMMIT_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const START_SHA = 'c'.repeat(40);
const EXPECTED_FOOTER = `<sub>Reviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) v${__PKG_VERSION__} for commit ${COMMIT_SHA}.</sub>`;

const refs: DiffRefs = {
  base_sha: BASE_SHA,
  start_sha: START_SHA,
  head_sha: COMMIT_SHA,
};

describe('buildCommentBody', () => {
  it('renders confidence between the body and the horizontal rule, before the footer', () => {
    const body = buildCommentBody('This looks off.', COMMIT_SHA, 'high');
    expect(body).toBe(`This looks off.\n\n_Confidence: high._\n\n---\n\n${EXPECTED_FOOTER}`);
  });

  it('reflects medium and low confidence values verbatim', () => {
    expect(buildCommentBody('ok', COMMIT_SHA, 'medium')).toContain('_Confidence: medium._');
    expect(buildCommentBody('ok', COMMIT_SHA, 'low')).toContain('_Confidence: low._');
  });

  it('trims leading/trailing whitespace from the reviewer body', () => {
    const body = buildCommentBody('  Trim me.  ', COMMIT_SHA, 'high');
    expect(body.startsWith('Trim me.')).toBe(true);
  });

  it('embeds the full 40-character SHA', () => {
    const body = buildCommentBody('ok', COMMIT_SHA, 'high');
    expect(body).toContain(COMMIT_SHA);
  });

  it('includes the package version in the footer', () => {
    const body = buildCommentBody('ok', COMMIT_SHA, 'high');
    expect(body).toContain(`v${__PKG_VERSION__} for commit ${COMMIT_SHA}`);
  });

  it('bolds the Conventional Comment title line', () => {
    const body = buildCommentBody(
      'issue (blocking): Loop runs N+1 attempts\n\nDiscussion text.',
      COMMIT_SHA,
      'high',
    );
    expect(body).toContain('**issue (blocking): Loop runs N+1 attempts**\n\nDiscussion text.');
  });

  it('bolds a title-only body without a discussion', () => {
    const body = buildCommentBody('nitpick: Helper name shadows the type', COMMIT_SHA, 'high');
    expect(body.startsWith('**nitpick: Helper name shadows the type**')).toBe(true);
  });

  it('leaves bodies that do not look like a Conventional Comment alone', () => {
    const body = buildCommentBody('Plain feedback without a label.', COMMIT_SHA, 'high');
    expect(body.startsWith('Plain feedback without a label.')).toBe(true);
    expect(body).not.toContain('**Plain feedback');
  });

  it('places the confidence line BEFORE the horizontal rule and footer', () => {
    const body = buildCommentBody('Body text.', COMMIT_SHA, 'low');
    const confIndex = body.indexOf('_Confidence: low._');
    const ruleIndex = body.indexOf('---');
    const footerIndex = body.indexOf(EXPECTED_FOOTER);
    expect(confIndex).toBeGreaterThan(0);
    expect(ruleIndex).toBeGreaterThan(confIndex);
    expect(footerIndex).toBeGreaterThan(ruleIndex);
  });
});

describe('buildGeneratedComments', () => {
  const comment: ReviewComment = {
    file: 'src/index.ts',
    line: 10,
    side: 'RIGHT',
    severity: 'warn',
    confidence: 'high',
    body: 'Consider using const here.',
  };

  // Minimal two-file diff so extractDiffHunkContext returns the fallback path
  // (file not found in diff → "file:side:line") without needing a real patch.
  const diff = '';

  it('adds the commit footer to the payload body', () => {
    const [generated] = buildGeneratedComments([comment], diff, refs, new Set());
    expect(generated.payload.body).toContain(EXPECTED_FOOTER);
    expect(generated.payload.body).toContain('---');
  });

  it('preserves the original comment body before the footer', () => {
    const [generated] = buildGeneratedComments([comment], diff, refs, new Set());
    expect(generated.payload.body).toContain(comment.body);
    const bodyIndex = generated.payload.body.indexOf(comment.body);
    const footerIndex = generated.payload.body.indexOf(EXPECTED_FOOTER);
    expect(footerIndex).toBeGreaterThan(bodyIndex);
  });

  it('appends fingerprint markers after the commit footer', () => {
    const [generated] = buildGeneratedComments([comment], diff, refs, new Set());
    const footerIndex = generated.payload.body.indexOf(EXPECTED_FOOTER);
    const fpIndex = generated.payload.body.indexOf('<!-- gitlab-review:fingerprint-primary:');
    expect(fpIndex).toBeGreaterThan(footerIndex);
  });

  it('fingerprints are stable regardless of the commit SHA in the footer', () => {
    const refs1 = { ...refs, head_sha: 'a'.repeat(40) };
    const refs2 = { ...refs, head_sha: 'd'.repeat(40) };
    const [gen1] = buildGeneratedComments([comment], diff, refs1, new Set());
    const [gen2] = buildGeneratedComments([comment], diff, refs2, new Set());
    expect(gen1.fingerprints.primary).toBe(gen2.fingerprints.primary);
    expect(gen1.fingerprints.secondary).toBe(gen2.fingerprints.secondary);
  });

  it('fingerprints are stable when only the confidence changes', () => {
    // Confidence is a display-only field rendered into the body wrapper. If
    // the reviewer revises its certainty across runs we must not duplicate
    // the comment.
    const high: ReviewComment = { ...comment, confidence: 'high' };
    const low: ReviewComment = { ...comment, confidence: 'low' };
    const [gen1] = buildGeneratedComments([high], diff, refs, new Set());
    const [gen2] = buildGeneratedComments([low], diff, refs, new Set());
    expect(gen1.fingerprints.primary).toBe(gen2.fingerprints.primary);
    expect(gen1.fingerprints.secondary).toBe(gen2.fingerprints.secondary);
  });

  it('marks a comment as duplicate when its fingerprints already exist', () => {
    const [first] = buildGeneratedComments([comment], diff, refs, new Set());
    const existing = new Set([first.fingerprints.primary]);
    const [second] = buildGeneratedComments([comment], diff, refs, existing);
    expect(second.duplicate).toBe(true);
  });
});
