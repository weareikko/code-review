import { normalizeBody } from './fingerprints.js';
import type { Discussion, DiscussionNote } from './gitlab.js';

const FINGERPRINT_MARKER_RE =
  /<!--\s*(?:gitlab-review|pi-reviewer):fingerprint-(?:primary|secondary):[a-f0-9]+\s*-->/i;

export interface PriorThread {
  file: string;
  line: number | null;
  resolved: boolean;
  /** Bot comment body with fingerprint markers and emoji prefixes stripped. */
  botComment: string;
  /** Human (non-system) reply bodies, in order. */
  replies: string[];
}

/**
 * Returns true when the note body contains a gitlab-review fingerprint marker.
 * Used to identify notes posted by the bot without needing a getCurrentUser() call.
 */
export function isBotNote(note: DiscussionNote): boolean {
  return FINGERPRINT_MARKER_RE.test(note.body ?? '');
}

/**
 * Parses the `+++ b/<path>` lines from a unified diff and returns the set of
 * new file paths. `/dev/null` (deleted files) is excluded.
 */
export function extractChangedFiles(diff: string): Set<string> {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match && match[1] !== '/dev/null') {
      files.add(match[1]);
    }
  }
  return files;
}

/**
 * Returns the line number for a discussion note's position.
 * Prefers the new-side line (`new_line`) then falls back to `old_line`.
 */
function positionLine(note: DiscussionNote): number | null {
  return note.position?.new_line ?? note.position?.old_line ?? null;
}

/**
 * Returns the file path for a discussion note's position.
 * Prefers the new path then falls back to the old path.
 */
function positionFile(note: DiscussionNote): string | null {
  return note.position?.new_path ?? note.position?.old_path ?? null;
}

/**
 * Extracts prior review threads from existing MR discussions that are relevant
 * to the current diff.
 *
 * A thread is included when:
 * - It contains at least one bot note (identified by fingerprint marker).
 * - It contains at least one non-system human reply after the bot note.
 * - The thread's file appears in `changedFiles`.
 *
 * Resolved threads are included but marked with `resolved: true` so the
 * reviewer can reference them without re-raising the concern.
 */
export function extractPriorThreads(
  discussions: Discussion[],
  changedFiles: Set<string>,
): PriorThread[] {
  const threads: PriorThread[] = [];

  for (const discussion of discussions) {
    const notes = discussion.notes ?? [];

    // Find the first bot note in the discussion.
    const botNoteIndex = notes.findIndex(isBotNote);
    if (botNoteIndex === -1) continue;

    const botNote = notes[botNoteIndex];
    const file = positionFile(botNote);

    // Skip threads not on a changed file (they're irrelevant to this review).
    if (!file || !changedFiles.has(file)) continue;

    // Collect human replies that come after the bot note.
    const replies = notes
      .slice(botNoteIndex + 1)
      .filter((n) => !n.system && (n.body?.trim() ?? ''))
      .filter((n) => !isBotNote(n))
      .map((n) => n.body?.trim() ?? '');

    if (replies.length === 0) continue;

    // A thread is considered resolved if any note in it is resolved.
    const resolved = notes.some((n) => n.resolved === true);

    threads.push({
      file,
      line: positionLine(botNote),
      resolved,
      botComment: normalizeBody(botNote.body ?? ''),
      replies,
    });
  }

  return threads;
}

/**
 * Renders a `<prior_review_feedback>` XML block from a list of prior threads.
 * Returns an empty string when `threads` is empty.
 */
export function renderPriorThreadsBlock(threads: PriorThread[]): string {
  if (threads.length === 0) return '';

  const threadXml = threads.map((t) => {
    const attrs = [
      `file="${t.file}"`,
      t.line !== null ? `line="${t.line}"` : null,
      `resolved="${t.resolved}"`,
    ]
      .filter(Boolean)
      .join(' ');

    const commentXml = `    <comment>${escapeXml(t.botComment)}</comment>`;
    const repliesXml = t.replies.map((r) => `    <reply>${escapeXml(r)}</reply>`).join('\n');

    return `  <thread ${attrs}>\n${commentXml}\n${repliesXml}\n  </thread>`;
  });

  return `<prior_review_feedback>\n${threadXml.join('\n')}\n</prior_review_feedback>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
