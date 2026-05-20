import { describe, expect, it } from 'vitest';
import { parseReviewMarkdown, parseReviewMarkdownWithWarnings } from './parser.js';

const LEGACY_PROJECT_MARKER = ['pi', 'reviewer'].join('-');

describe('gitlab-review parsing', () => {
  it('parses inline comment blocks with severity and body normalization', () => {
    const markdown = [
      'Review summary',
      '== Inline Comments ==',
      '🟡 src/app.ts:10 (RIGHT)',
      'Please simplify this branch.',
      '',
      '🔴 `src/legacy.ts:5` - LEFT',
      'remove dead code <!-- gitlab-review:fingerprint-primary:abcd -->',
    ].join('\n');

    expect(parseReviewMarkdown(markdown)).toEqual([
      {
        file: 'src/app.ts',
        line: 10,
        side: 'RIGHT',
        severity: 'warn',
        body: 'Please simplify this branch.',
      },
      {
        file: 'src/legacy.ts',
        line: 5,
        side: 'LEFT',
        severity: 'critical',
        body: 'remove dead code',
      },
    ]);
  });

  it('parses JSON comment fences and legacy markers', () => {
    const markdown = [
      '```json',
      '{"comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix this"}]}',
      '```',
      '<!-- gitlab-review-comment {"file":"src/b.ts","old_line":9,"body":"Old side"} -->',
      `<!-- ${LEGACY_PROJECT_MARKER}-comment {"file":"src/c.ts","line":11,"body":"Older side"} -->`,
    ].join('\n');

    expect(parseReviewMarkdown(markdown)).toEqual([
      { file: 'src/a.ts', line: 3, side: 'RIGHT', severity: 'info', body: 'Fix this' },
      { file: 'src/b.ts', line: 9, side: 'LEFT', severity: 'info', body: 'Old side' },
      { file: 'src/c.ts', line: 11, side: 'RIGHT', severity: 'info', body: 'Older side' },
    ]);
  });

  it('parses JSON comment fences whose bodies contain fenced code blocks', () => {
    const payload = {
      comments: [
        {
          file: 'config/bot/review.yml',
          line: 8,
          side: 'RIGHT',
          severity: 'CRITICAL',
          body: 'Use this syntax:\n\n```yaml\n- if: $CI_PIPELINE_SOURCE == "web"\n```',
        },
      ],
    };
    const markdown = ['```json', JSON.stringify(payload, null, 2), '```'].join('\n');

    expect(parseReviewMarkdown(markdown)).toEqual([
      {
        file: 'config/bot/review.yml',
        line: 8,
        side: 'RIGHT',
        severity: 'critical',
        body: 'Use this syntax:\n\n```yaml\n- if: $CI_PIPELINE_SOURCE == "web"\n```',
      },
    ]);
  });

  it('emits warnings for text before the first parseable inline header', () => {
    const markdown = [
      '== Inline Comments ==',
      'I should be ignored',
      '🔵 src/file.ts:1 (RIGHT)',
      'Valid comment',
    ].join('\n');

    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.comments).toHaveLength(1);
    expect(result.warnings).toEqual([
      'Ignored text in the inline comments section before the first parseable comment header.',
    ]);
  });

  it('extracts the top-level summary field from JSON fences', () => {
    const markdown = [
      '```json',
      JSON.stringify({
        summary: '**Overall:** looks good, minor nits inline.',
        comments: [{ file: 'src/a.ts', line: 1, side: 'RIGHT', body: 'nit' }],
      }),
      '```',
    ].join('\n');

    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.summary).toBe('**Overall:** looks good, minor nits inline.');
    expect(result.comments).toHaveLength(1);
  });

  it('returns null summary when the JSON object has no summary field', () => {
    const markdown = ['```json', '{"comments":[]}', '```'].join('\n');
    expect(parseReviewMarkdownWithWarnings(markdown).summary).toBeNull();
  });

  it('returns null summary when the summary is an empty string', () => {
    const markdown = ['```json', JSON.stringify({ summary: '   ', comments: [] }), '```'].join(
      '\n',
    );
    expect(parseReviewMarkdownWithWarnings(markdown).summary).toBeNull();
  });
});
