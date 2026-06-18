import { describe, expect, it } from 'vitest';
import { parseReviewMarkdown, parseReviewMarkdownWithWarnings } from './parser.js';

describe('gitlab-review parsing', () => {
  it('parses inline comment blocks with body normalization', () => {
    const markdown = [
      'Review summary',
      '== Inline Comments ==',
      'src/app.ts:10 (RIGHT)',
      'Please simplify this branch.',
      '',
      '`src/legacy.ts:5` - LEFT',
      'remove dead code <!-- gitlab-review:fingerprint-primary:abcd -->',
    ].join('\n');

    expect(parseReviewMarkdown(markdown)).toEqual([
      {
        file: 'src/app.ts',
        line: 10,
        side: 'RIGHT',
        severity: 'info',
        confidence: 'high',
        body: 'Please simplify this branch.',
      },
      {
        file: 'src/legacy.ts',
        line: 5,
        side: 'LEFT',
        severity: 'info',
        confidence: 'high',
        body: 'remove dead code',
      },
    ]);
  });

  it('parses JSON comment fences and embedded comment markers', () => {
    const markdown = [
      '```json',
      '{"comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix this"}]}',
      '```',
      '<!-- gitlab-review-comment {"file":"src/b.ts","old_line":9,"body":"Old side"} -->',
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
      'src/file.ts:1 (RIGHT)',
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
    expect(result).toEqual({ comments: [], summary: null, warnings: [], malformed: null });
  });

  it('flags malformed when a ```json fence cannot be parsed or repaired', () => {
    const markdown = [
      'Here is the review:',
      '```json',
      // Backtick code spans with braces plus later unescaped double quotes — the
      // real-world failure mode that defeats both strict parsing and repair.
      '{"summary":"`computeDiff` returns `{ a, b }`. Two commits ("foo" and "bar") not in diff.","comments":[]}',
      '```',
    ].join('\n');
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed?.reason).toBe('fence_unparseable');
    expect(result.malformed?.preview).toContain('computeDiff');
    expect(result.comments).toEqual([]);
    expect(result.summary).toBeNull();
  });

  it('flags malformed for an unfenced reviewer object that cannot be parsed', () => {
    const markdown =
      '{\n  "summary": "`fn` returns `{ x }`. Renamed ("foo" and "bar").",\n  "comments": []\n}';
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed?.reason).toBe('object_unparseable');
  });

  it('does not flag malformed for the legacy inline-comment markdown format', () => {
    const markdown = ['== Inline Comments ==', 'src/a.ts:3 (RIGHT)', 'Fix this'].join('\n');
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed).toBeNull();
    expect(result.comments).toHaveLength(1);
  });

  it('anchors extraction on the reviewer key, ignoring code-span braces in prose', () => {
    // A brace-laden prose object precedes the real reviewer object; anchoring on
    // the `{"summary"` key must skip the decoy and recover the real review.
    const markdown = [
      'The function returns { entries, slotReplacements } now.',
      '',
      '{"summary":"ok","comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix this"}]}',
    ].join('\n');
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed).toBeNull();
    expect(result.summary).toBe('ok');
    expect(result.comments).toHaveLength(1);
  });

  it('recovers an unfenced reviewer object whose first key is not summary/comments', () => {
    // Anchored extraction must not drop a valid reviewer object that simply
    // leads with another key; the full-scan fallback recovers it.
    const markdown =
      '{"version":1,"summary":"S","comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix"}]}';
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed).toBeNull();
    expect(result.summary).toBe('S');
    expect(result.comments).toHaveLength(1);
  });

  it('keeps a legacy inline review when an unparseable ```json fence coexists', () => {
    // A stray unrepairable fenced block must not discard a usable review carried
    // in the legacy inline-comment section; the failure downgrades to a warning.
    const markdown = [
      '```json',
      '{"summary":"`fn` returns `{ a, b }`. Commits ("foo" and "bar").","comments":[]}',
      '```',
      '',
      '== Inline Comments ==',
      'src/a.ts:3 (RIGHT)',
      'A real, valid inline finding',
    ].join('\n');
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed).toBeNull();
    expect(result.comments).toHaveLength(1);
    expect(result.warnings.some((w) => /recovered from other sections/.test(w))).toBe(true);
  });

  it('does not let an unrelated valid ```json fence mask a malformed reviewer object', () => {
    // A parseable but non-reviewer-shaped fence must not suppress the failure of
    // a genuinely unparseable reviewer object elsewhere.
    const markdown = [
      '```json',
      '{"config":true}',
      '```',
      '',
      '{"summary":"`fn` returns `{ a, b }`. ("foo" and "bar")","comments":[]}',
    ].join('\n');
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed?.reason).toBe('object_unparseable');
    expect(result.malformed?.preview).toContain('summary');
  });

  it('does not flag malformed for an empty ```json fence', () => {
    const markdown = ['```json', '', '```'].join('\n');
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed).toBeNull();
    expect(result.comments).toEqual([]);
  });

  it('repairs a recoverable JSON defect (trailing comma) and warns', () => {
    const markdown = [
      '```json',
      '{"summary":"ok","comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix this"},]}',
      '```',
    ].join('\n');
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed).toBeNull();
    expect(result.comments).toHaveLength(1);
    expect(result.summary).toBe('ok');
    expect(result.warnings.some((w) => /best-effort repair/.test(w))).toBe(true);
  });

  it('repairs a recoverable unfenced reviewer object before failing loudly', () => {
    // No fence; trailing comma makes strict parsing fail but repair recovers it.
    const markdown =
      'Here is my review:\n\n{"summary":"ok","comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix this"},]}';
    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.malformed).toBeNull();
    expect(result.comments).toHaveLength(1);
    expect(result.summary).toBe('ok');
    expect(result.warnings.some((w) => /best-effort repair/.test(w))).toBe(true);
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
