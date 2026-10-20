/**
 * Author-declared intent for the change, sourced from the GitLab MR.
 * Both fields are optional and may be empty/whitespace — the renderer degrades
 * gracefully and emits no intent block when there is nothing meaningful to show.
 */
export interface ReviewIntent {
  title?: string;
  description?: string | null;
}

/** Max characters of MR description injected into the prompt to bound token cost. */
const MAX_INTENT_DESCRIPTION_CHARS = 4_000;

/**
 * Renders the author-declared intent (MR title + description) as a clearly
 * delimited `<intent>` block. Returns an empty string when neither field has
 * meaningful content, so a missing/empty description degrades gracefully.
 * The description is trimmed and length-capped to bound token cost.
 *
 * Lives in its own module because both the Find prompt (`gitlab-review.ts`) and
 * the Verify prompt (`verify.ts`) render it, and `gitlab-review.ts` already
 * imports `verify.ts` — keeping it here avoids an import cycle.
 */
export function renderIntentBlock(intent: ReviewIntent | undefined): string {
  if (!intent) return '';
  const title = intent.title?.trim() ?? '';
  let description = intent.description?.trim() ?? '';
  if (!title && !description) return '';

  if (description.length > MAX_INTENT_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_INTENT_DESCRIPTION_CHARS)}\n… (description truncated)`;
  }

  const lines = ['<intent>'];
  if (title) lines.push(`<title>${title}</title>`);
  if (description) lines.push(`<description>\n${description}\n</description>`);
  lines.push('</intent>');
  return lines.join('\n');
}
