import { describe, expect, it } from 'vitest';
import type { Discussion } from './gitlab.js';
import {
  extractChangedFiles,
  extractPriorThreads,
  isBotNote,
  renderPriorThreadsBlock,
} from './prior-threads.js';

// ---------------------------------------------------------------------------
// isBotNote
// ---------------------------------------------------------------------------

describe('isBotNote', () => {
  it('returns true for a note with a primary fingerprint marker', () => {
    expect(
      isBotNote({
        body: 'Some comment\n\n<!-- gitlab-review:fingerprint-primary:abc123 -->',
      }),
    ).toBe(true);
  });

  it('returns true for a note with a secondary fingerprint marker', () => {
    expect(
      isBotNote({
        body: 'Some comment\n\n<!-- gitlab-review:fingerprint-secondary:def456 -->',
      }),
    ).toBe(true);
  });

  it('returns false for a plain human note', () => {
    expect(isBotNote({ body: 'Thanks, fixed.' })).toBe(false);
  });

  it('returns false for a note with null body', () => {
    expect(isBotNote({ body: null })).toBe(false);
  });

  it('returns false for a note with no body', () => {
    expect(isBotNote({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractChangedFiles
// ---------------------------------------------------------------------------

describe('extractChangedFiles', () => {
  it('extracts new file paths from +++ b/ lines', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/bar.ts b/src/bar.ts',
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');

    const files = extractChangedFiles(diff);
    expect(files).toEqual(new Set(['src/foo.ts', 'src/bar.ts']));
  });

  it('excludes /dev/null (deleted files)', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/old.ts',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-removed',
    ].join('\n');

    const files = extractChangedFiles(diff);
    expect(files.size).toBe(0);
  });

  it('returns an empty set for an empty diff', () => {
    expect(extractChangedFiles('')).toEqual(new Set());
  });

  it('handles files with spaces and special characters', () => {
    const diff = '+++ b/src/my component.ts\n+++ b/src/foo-bar_baz.ts';
    const files = extractChangedFiles(diff);
    expect(files).toEqual(new Set(['src/my component.ts', 'src/foo-bar_baz.ts']));
  });
});

// ---------------------------------------------------------------------------
// extractPriorThreads
// ---------------------------------------------------------------------------

const BOT_BODY =
  'This is a bug.\n\n<!-- gitlab-review:fingerprint-primary:aaa -->\n<!-- gitlab-review:fingerprint-secondary:bbb -->';

function makeDiscussion(overrides: Partial<Discussion> = {}): Discussion {
  return { notes: [], ...overrides };
}

describe('extractPriorThreads', () => {
  const changedFiles = new Set(['src/foo.ts']);

  it('returns a thread when a bot note has a human reply on a changed file', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { new_path: 'src/foo.ts', new_line: 42 },
          },
          {
            body: 'Thanks, will fix.',
            system: false,
          },
        ],
      }),
    ];

    const threads = extractPriorThreads(discussions, changedFiles);
    expect(threads).toHaveLength(1);
    expect(threads[0].file).toBe('src/foo.ts');
    expect(threads[0].line).toBe(42);
    expect(threads[0].resolved).toBe(false);
    expect(threads[0].replies).toEqual(['Thanks, will fix.']);
  });

  it('strips fingerprint markers from botComment', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { new_path: 'src/foo.ts', new_line: 10 },
          },
          { body: 'Acknowledged.' },
        ],
      }),
    ];

    const threads = extractPriorThreads(discussions, changedFiles);
    expect(threads[0].botComment).not.toContain('fingerprint');
    expect(threads[0].botComment).toBe('This is a bug.');
  });

  it('skips discussions with no bot note', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          { body: 'Human comment', position: { new_path: 'src/foo.ts', new_line: 1 } },
          { body: 'Another human reply' },
        ],
      }),
    ];

    expect(extractPriorThreads(discussions, changedFiles)).toHaveLength(0);
  });

  it('skips discussions with no human replies after the bot note', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { new_path: 'src/foo.ts', new_line: 5 },
          },
        ],
      }),
    ];

    expect(extractPriorThreads(discussions, changedFiles)).toHaveLength(0);
  });

  it('skips threads whose file is not in changedFiles', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { new_path: 'src/other.ts', new_line: 1 },
          },
          { body: 'Reply here.' },
        ],
      }),
    ];

    expect(extractPriorThreads(discussions, changedFiles)).toHaveLength(0);
  });

  it('skips threads with no file position', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [{ body: BOT_BODY }, { body: 'Reply.' }],
      }),
    ];

    expect(extractPriorThreads(discussions, changedFiles)).toHaveLength(0);
  });

  it('excludes system notes from replies', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { new_path: 'src/foo.ts', new_line: 3 },
          },
          { body: 'Thread resolved.', system: true },
          { body: 'Fixed in next commit.', system: false },
        ],
      }),
    ];

    const threads = extractPriorThreads(discussions, changedFiles);
    expect(threads[0].replies).toEqual(['Fixed in next commit.']);
  });

  it('excludes bot follow-up notes from replies', () => {
    const BOT_FOLLOW_UP =
      'Still an issue.\n\n<!-- gitlab-review:fingerprint-primary:ccc -->\n<!-- gitlab-review:fingerprint-secondary:ddd -->';
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { new_path: 'src/foo.ts', new_line: 7 },
          },
          { body: 'I disagree.' },
          { body: BOT_FOLLOW_UP },
          { body: 'OK you have a point.' },
        ],
      }),
    ];

    const threads = extractPriorThreads(discussions, changedFiles);
    expect(threads[0].replies).toEqual(['I disagree.', 'OK you have a point.']);
  });

  it('marks threads as resolved when any note has resolved: true', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { new_path: 'src/foo.ts', new_line: 20 },
            resolved: true,
          },
          { body: 'Fixed.' },
        ],
      }),
    ];

    const threads = extractPriorThreads(discussions, changedFiles);
    expect(threads[0].resolved).toBe(true);
  });

  it('falls back to old_line when new_line is absent', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { new_path: 'src/foo.ts', old_line: 15 },
          },
          { body: 'Got it.' },
        ],
      }),
    ];

    const threads = extractPriorThreads(discussions, changedFiles);
    expect(threads[0].line).toBe(15);
  });

  it('falls back to old_path when new_path is absent', () => {
    const filesWithOld = new Set(['src/old.ts']);
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { old_path: 'src/old.ts', new_line: 1 },
          },
          { body: 'Noted.' },
        ],
      }),
    ];

    const threads = extractPriorThreads(discussions, filesWithOld);
    expect(threads[0].file).toBe('src/old.ts');
  });

  it('collects multiple replies in order', () => {
    const discussions: Discussion[] = [
      makeDiscussion({
        notes: [
          {
            body: BOT_BODY,
            position: { new_path: 'src/foo.ts', new_line: 1 },
          },
          { body: 'First reply.' },
          { body: 'Second reply.' },
          { body: 'Third reply.' },
        ],
      }),
    ];

    const threads = extractPriorThreads(discussions, changedFiles);
    expect(threads[0].replies).toEqual(['First reply.', 'Second reply.', 'Third reply.']);
  });
});

// ---------------------------------------------------------------------------
// renderPriorThreadsBlock
// ---------------------------------------------------------------------------

describe('renderPriorThreadsBlock', () => {
  it('returns empty string for an empty array', () => {
    expect(renderPriorThreadsBlock([])).toBe('');
  });

  it('wraps output in <prior_review_feedback>', () => {
    const threads = [
      {
        file: 'src/foo.ts',
        line: 42,
        resolved: false,
        botComment: 'Missing null check.',
        replies: ['Fixed.'],
      },
    ];

    const block = renderPriorThreadsBlock(threads);
    expect(block).toContain('<prior_review_feedback>');
    expect(block).toContain('</prior_review_feedback>');
  });

  it('renders file, line, and resolved as attributes', () => {
    const block = renderPriorThreadsBlock([
      { file: 'src/a.ts', line: 10, resolved: true, botComment: 'Bug.', replies: ['Done.'] },
    ]);

    expect(block).toContain('file="src/a.ts"');
    expect(block).toContain('line="10"');
    expect(block).toContain('resolved="true"');
  });

  it('omits the line attribute when line is null', () => {
    const block = renderPriorThreadsBlock([
      { file: 'src/a.ts', line: null, resolved: false, botComment: 'Note.', replies: ['Ack.'] },
    ]);

    expect(block).not.toContain('line=');
  });

  it('renders <comment> and <reply> elements', () => {
    const block = renderPriorThreadsBlock([
      {
        file: 'src/a.ts',
        line: 1,
        resolved: false,
        botComment: 'The cache is not keyed.',
        replies: ['Good catch, fixing now.'],
      },
    ]);

    expect(block).toContain('<comment>The cache is not keyed.</comment>');
    expect(block).toContain('<reply>Good catch, fixing now.</reply>');
  });

  it('escapes XML special characters in comment and reply', () => {
    const block = renderPriorThreadsBlock([
      {
        file: 'src/a.ts',
        line: 1,
        resolved: false,
        botComment: 'Use <T> & check "null".',
        replies: ["It's a <string> issue."],
      },
    ]);

    expect(block).toContain('&lt;T&gt; &amp; check &quot;null&quot;');
    expect(block).toContain('It&apos;s a &lt;string&gt; issue.');
  });

  it('renders multiple threads', () => {
    const block = renderPriorThreadsBlock([
      { file: 'src/a.ts', line: 1, resolved: false, botComment: 'A.', replies: ['R1.'] },
      { file: 'src/b.ts', line: 2, resolved: true, botComment: 'B.', replies: ['R2.'] },
    ]);

    expect(block).toContain('file="src/a.ts"');
    expect(block).toContain('file="src/b.ts"');
  });

  it('renders multiple replies as separate <reply> elements', () => {
    const block = renderPriorThreadsBlock([
      {
        file: 'src/a.ts',
        line: 1,
        resolved: false,
        botComment: 'Issue here.',
        replies: ['First.', 'Second.', 'Third.'],
      },
    ]);

    const replyMatches = block.match(/<reply>/g);
    expect(replyMatches).toHaveLength(3);
  });
});
