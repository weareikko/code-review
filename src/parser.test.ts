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
        confidence: 'high',
        body: 'Please simplify this branch.',
      },
      {
        file: 'src/legacy.ts',
        line: 5,
        side: 'LEFT',
        severity: 'critical',
        confidence: 'high',
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
      {
        file: 'src/a.ts',
        line: 3,
        side: 'RIGHT',
        severity: 'info',
        confidence: 'high',
        body: 'Fix this',
      },
      {
        file: 'src/b.ts',
        line: 9,
        side: 'LEFT',
        severity: 'info',
        confidence: 'high',
        body: 'Old side',
      },
      {
        file: 'src/c.ts',
        line: 11,
        side: 'RIGHT',
        severity: 'info',
        confidence: 'high',
        body: 'Older side',
      },
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
        confidence: 'high',
        body: 'Use this syntax:\n\n```yaml\n- if: $CI_PIPELINE_SOURCE == "web"\n```',
      },
    ]);
  });

  it('reads the confidence field and normalises common aliases', () => {
    const markdown = [
      '```json',
      JSON.stringify({
        comments: [
          {
            file: 'a.ts',
            line: 1,
            side: 'RIGHT',
            severity: 'WARN',
            confidence: 'medium',
            body: 'a',
          },
          { file: 'b.ts', line: 2, side: 'RIGHT', severity: 'WARN', confidence: 'LOW', body: 'b' },
          { file: 'c.ts', line: 3, side: 'RIGHT', severity: 'WARN', confidence: 'med', body: 'c' },
          { file: 'd.ts', line: 4, side: 'RIGHT', severity: 'WARN', body: 'd' },
        ],
      }),
      '```',
    ].join('\n');

    const result = parseReviewMarkdown(markdown);
    expect(result.map((c) => c.confidence)).toEqual(['medium', 'low', 'medium', 'high']);
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

  it('parses a bare unfenced JSON object with comments and summary', () => {
    const markdown = JSON.stringify({
      summary: 'Looks reasonable overall.',
      comments: [{ file: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Fix this' }],
    });

    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.summary).toBe('Looks reasonable overall.');
    expect(result.comments).toEqual([
      {
        file: 'src/a.ts',
        line: 3,
        side: 'RIGHT',
        severity: 'info',
        confidence: 'high',
        body: 'Fix this',
      },
    ]);
  });

  it('parses an unfenced JSON object appended after prose', () => {
    const markdown = [
      'Here is my review of the merge request. Overall it is fine but I left a note.',
      '',
      JSON.stringify({
        summary: 'A note about a.ts.',
        comments: [{ file: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Consider renaming' }],
      }),
    ].join('\n');

    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.summary).toBe('A note about a.ts.');
    expect(result.comments).toEqual([
      {
        file: 'src/a.ts',
        line: 7,
        side: 'RIGHT',
        severity: 'info',
        confidence: 'high',
        body: 'Consider renaming',
      },
    ]);
  });

  it('parses an unfenced JSON object followed by trailing prose', () => {
    const markdown = [
      JSON.stringify({
        summary: 'Trailing prose follows.',
        comments: [{ file: 'src/b.ts', line: 4, side: 'RIGHT', body: 'Tidy up' }],
      }),
      '',
      'Thanks for reading, let me know if you have any questions.',
    ].join('\n');

    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.summary).toBe('Trailing prose follows.');
    expect(result.comments).toEqual([
      {
        file: 'src/b.ts',
        line: 4,
        side: 'RIGHT',
        severity: 'info',
        confidence: 'high',
        body: 'Tidy up',
      },
    ]);
  });

  it('matches the full unfenced object when string values contain braces', () => {
    const markdown = JSON.stringify({
      summary: 'Use a literal like { key: value } in the docs.',
      comments: [
        { file: 'src/c.ts', line: 2, side: 'RIGHT', body: 'Replace with `{ a: 1 }` here }' },
      ],
    });

    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.summary).toBe('Use a literal like { key: value } in the docs.');
    expect(result.comments).toEqual([
      {
        file: 'src/c.ts',
        line: 2,
        side: 'RIGHT',
        severity: 'info',
        confidence: 'high',
        body: 'Replace with `{ a: 1 }` here }',
      },
    ]);
  });

  it('resolves gracefully for malformed, non-JSON prose without throwing', () => {
    const result = parseReviewMarkdownWithWarnings('this is just prose { not json');
    expect(result).toEqual({ comments: [], summary: null, warnings: [] });
  });

  it('does not run the unfenced fallback when a JSON fence parsed successfully', () => {
    const markdown = [
      '```json',
      '{"comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix this"}]}',
      '```',
      '',
      'Some trailing prose with a stray brace { and another } object {"comments":[{"file":"src/x.ts","line":1,"side":"RIGHT","body":"should not be counted"}]}',
    ].join('\n');

    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.comments).toEqual([
      {
        file: 'src/a.ts',
        line: 3,
        side: 'RIGHT',
        severity: 'info',
        confidence: 'high',
        body: 'Fix this',
      },
    ]);
  });
});
