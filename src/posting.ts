import { extractExistingFingerprints } from './fingerprints.js';
import type { Discussion, GitLabClient } from './gitlab.js';
import type { Fingerprints, GeneratedComment } from './types.js';

export const SUMMARY_MARKER = '<!-- gitlab-review:summary -->';
export const SUMMARY_HISTORY_START = '<!-- gitlab-review:summary-history:start -->';
export const SUMMARY_HISTORY_END = '<!-- gitlab-review:summary-history:end -->';
export const SUMMARY_HISTORY_ENTRY_START = '<!-- gitlab-review:summary-history-entry:start -->';
export const SUMMARY_HISTORY_ENTRY_END = '<!-- gitlab-review:summary-history-entry:end -->';
export const SUMMARY_HISTORY_LIMIT = 10;
export const REVIEWED_COMMIT_FOOTER_PATTERN =
  /Reviewed by \[@ikko-dev\/gitlab-review\]\(https:\/\/github\.com\/ikko-dev\/gitlab-review\)(?: v\S+)? for commit ([a-f0-9]{40})\./i;

declare const __PKG_VERSION__: string;

export type SummaryAction = 'created' | 'updated';

export interface SummaryResult {
  action: SummaryAction;
  noteId?: number;
}

export interface SummaryNote {
  id: number;
  body: string;
}

/**
 * A file dropped from the reviewed diff because the cumulative diff exceeded the
 * char budget (distinct from quiet noise skips like lockfiles). `chars` is the
 * size of that file's diff section.
 */
export interface SizeSkippedFile {
  path: string;
  chars: number;
}

/**
 * MR-level "this change is too big" signal. Surfaced as a prominent callout at
 * the top of the summary so a reviewer cannot miss that part of the change went
 * unreviewed or that the MR is past a human's reviewability threshold.
 */
export interface SizeNotice {
  /** Files dropped for exceeding the char budget. */
  sizeSkippedFiles?: SizeSkippedFile[];
  /** Set when the reviewed diff's changed-line count crossed the configured threshold. */
  decomposeHint?: { lines: number; threshold: number };
}

export interface SummaryBodyOptions {
  historyEntries?: string[];
  reviewedCommitSha?: string;
  skillsFooter?: string;
  runId?: string;
  /** Prominent size/decompose callout rendered above the reviewer's summary. */
  sizeNotice?: SizeNotice;
}

export interface UpsertSummaryOptions extends SummaryBodyOptions {
  archivedAt?: Date;
  costFooter?: string;
}

function formatChars(chars: number): string {
  if (chars >= 1000) return `${Math.round(chars / 1000)}k chars`;
  return `${chars} chars`;
}

/**
 * Render the prominent size/decompose callout that sits directly under the
 * "### Code Review" heading. Returns an empty string when there is nothing to
 * surface, so the summary body is byte-for-byte unchanged in the common case.
 */
export function buildSizeNoticeBlock(notice?: SizeNotice): string {
  if (!notice) return '';
  const sizeSkippedFiles = notice.sizeSkippedFiles ?? [];
  const blocks: string[] = [];

  if (sizeSkippedFiles.length > 0) {
    const fileList = sizeSkippedFiles
      .map((file) => `- \`${file.path}\` (${formatChars(file.chars)})`)
      .join('\n');
    blocks.push(
      [
        `> [!WARNING]`,
        `> **${sizeSkippedFiles.length} file(s) were not reviewed** — the diff exceeded the size budget, so these files were dropped from the review:`,
        `>`,
        ...fileList.split('\n').map((line) => `> ${line}`),
        `>`,
        `> This MR is past the reviewability threshold. **Split this MR into smaller, atomic changes** so the whole change can be reviewed.`,
      ].join('\n'),
    );
  }

  if (notice.decomposeHint) {
    const { lines, threshold } = notice.decomposeHint;
    blocks.push(
      [
        `> [!NOTE]`,
        `> This MR changes **${lines} lines**, above the configured threshold of **${threshold}**. Consider decomposing this MR into atomic changes — smaller MRs get more thorough review and merge faster.`,
      ].join('\n'),
    );
  }

  return blocks.join('\n\n');
}

export function buildSummaryBody(
  summary: string,
  costFooter?: string,
  options: SummaryBodyOptions = {},
): string {
  const sizeNotice = buildSizeNoticeBlock(options.sizeNotice);
  const header = sizeNotice ? `${sizeNotice}\n\n${summary.trim()}` : summary.trim();
  const body = `${SUMMARY_MARKER}\n\n### Code Review\n\n${header}`;
  const footerLines = [
    costFooter?.trim(),
    options.skillsFooter?.trim(),
    options.reviewedCommitSha ? buildReviewedCommitFooter(options.reviewedCommitSha) : undefined,
    options.runId ? `<sub>Run ID: \`${options.runId}\`</sub>` : undefined,
  ].filter((line): line is string => Boolean(line));
  const withFooter =
    footerLines.length > 0 ? `${body}\n\n---\n\n${footerLines.join('\n\n')}` : body;
  const historyEntries = options.historyEntries?.filter((entry) => entry.trim().length > 0) ?? [];
  if (historyEntries.length === 0) return withFooter;
  return `${withFooter}\n\n${buildSummaryHistoryBlock(historyEntries)}`;
}

export function buildReviewedCommitFooter(commitSha: string): string {
  return `Reviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) v${__PKG_VERSION__} for commit ${commitSha}.`;
}

export function extractReviewedCommitSha(body: string): string | null {
  return REVIEWED_COMMIT_FOOTER_PATTERN.exec(body)?.[1] ?? null;
}

export function findExistingReviewedCommitSha(discussions: Discussion[]): string | null {
  const body = findExistingSummaryNote(discussions)?.body;
  return body ? extractReviewedCommitSha(stripSummaryHistory(body)) : null;
}

export function findExistingSummaryNote(discussions: Discussion[]): SummaryNote | null {
  for (const discussion of discussions) {
    for (const note of discussion.notes ?? []) {
      const id = note.id;
      if (typeof id !== 'number') continue;
      const body = note.body;
      if (typeof body === 'string' && body.includes(SUMMARY_MARKER)) {
        return { id, body };
      }
    }
  }
  return null;
}

export function findExistingSummaryNoteId(discussions: Discussion[]): number | null {
  return findExistingSummaryNote(discussions)?.id ?? null;
}

export function buildArchivedSummaryEntry(body: string, archivedAt = new Date()): string {
  const trimmed = body.trim();
  return [
    SUMMARY_HISTORY_ENTRY_START,
    `### Previous run archived ${formatSummaryArchiveDate(archivedAt)}`,
    '',
    trimmed,
    SUMMARY_HISTORY_ENTRY_END,
  ].join('\n');
}

export function extractSummaryHistoryEntries(body: string): string[] {
  const entries: string[] = [];
  const entryPattern = new RegExp(
    `${escapeRegExp(SUMMARY_HISTORY_ENTRY_START)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(SUMMARY_HISTORY_ENTRY_END)}`,
    'g',
  );
  for (const match of body.matchAll(entryPattern)) {
    const entry = match[1]?.trim();
    if (entry)
      entries.push(`${SUMMARY_HISTORY_ENTRY_START}\n${entry}\n${SUMMARY_HISTORY_ENTRY_END}`);
  }
  return entries;
}

export function stripSummaryHistory(body: string): string {
  const start = body.indexOf(SUMMARY_HISTORY_START);
  if (start === -1) return body.trim();

  const detailsStart = body.lastIndexOf('<details>', start);
  const blockStart = detailsStart === -1 ? start : detailsStart;
  const endMarkerStart = body.indexOf(SUMMARY_HISTORY_END, start);
  const endMarkerEnd =
    endMarkerStart === -1
      ? start + SUMMARY_HISTORY_START.length
      : endMarkerStart + SUMMARY_HISTORY_END.length;
  const detailsEnd = body.indexOf('</details>', endMarkerEnd);
  const blockEnd = detailsEnd === -1 ? endMarkerEnd : detailsEnd + '</details>'.length;

  return `${body.slice(0, blockStart)}${body.slice(blockEnd)}`.trim();
}

export function stripSummaryMarker(body: string): string {
  return body.replace(SUMMARY_MARKER, '').trim();
}

export function buildSummaryHistoryEntries(
  existingBody: string,
  archivedAt = new Date(),
): string[] {
  const latestPrevious = stripSummaryMarker(stripSummaryHistory(existingBody));
  const previousEntries = extractSummaryHistoryEntries(existingBody);
  const nextEntries = latestPrevious
    ? [buildArchivedSummaryEntry(latestPrevious, archivedAt), ...previousEntries]
    : previousEntries;
  return nextEntries.slice(0, SUMMARY_HISTORY_LIMIT);
}

export async function upsertSummaryNote(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  summary: string,
  discussions: Discussion[],
  costFooterOrOptions?: string | UpsertSummaryOptions,
): Promise<SummaryResult> {
  const options =
    typeof costFooterOrOptions === 'string'
      ? { costFooter: costFooterOrOptions }
      : (costFooterOrOptions ?? {});
  const existing = findExistingSummaryNote(discussions);
  const historyEntries = existing
    ? buildSummaryHistoryEntries(existing.body, options.archivedAt)
    : (options.historyEntries ?? []);
  const body = buildSummaryBody(summary, options.costFooter, {
    historyEntries,
    reviewedCommitSha: options.reviewedCommitSha,
    skillsFooter: options.skillsFooter,
    sizeNotice: options.sizeNotice,
  });
  if (existing) {
    await gitlab.updateMergeRequestNote(project, mr, existing.id, body);
    return { action: 'updated', noteId: existing.id };
  }
  const created = await gitlab.createMergeRequestNote(project, mr, body);
  return { action: 'created', noteId: created.id };
}

function buildSummaryHistoryBlock(entries: string[]): string {
  return [
    '<details>',
    '<summary>Previous review runs</summary>',
    '',
    SUMMARY_HISTORY_START,
    '',
    entries.join('\n\n'),
    '',
    SUMMARY_HISTORY_END,
    '',
    '</details>',
  ].join('\n');
}

function formatSummaryArchiveDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type PostingMode = 'direct' | 'draft';

export const POSTING_MODES: readonly PostingMode[] = ['direct', 'draft'];

export const DRAFT_CONCURRENCY = 10;

export interface PostResult {
  posted: number;
  drafts?: {
    abandoned: number;
    created: number;
    deletedPrePublish: number;
    published: number;
    /**
     * Drafts that survived the pre-publish race check but could not be
     * published, counted only on the per-draft fallback path (a `bulk_publish`
     * 500 forced individual publishes and some still failed). 0 on the normal
     * path. A non-zero value means inline comments were silently dropped.
     */
    publishFailed: number;
  };
}

export async function postGeneratedComments(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  generated: GeneratedComment[],
  mode: PostingMode = 'direct',
): Promise<PostResult> {
  const fresh = generated.filter((item) => !item.duplicate);
  if (mode === 'draft') return postViaDrafts(gitlab, project, mr, fresh);
  if (fresh.length === 0) return { posted: 0 };
  return postDirectly(gitlab, project, mr, fresh);
}

async function postDirectly(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  fresh: GeneratedComment[],
): Promise<PostResult> {
  let posted = 0;
  for (const item of fresh) {
    await gitlab.postDiscussion(project, mr, item.payload);
    posted += 1;
  }
  return { posted };
}

interface DraftRecord {
  id: number;
  fingerprints: Fingerprints;
}

async function postViaDrafts(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  fresh: GeneratedComment[],
): Promise<PostResult> {
  const abandoned = await cleanupOrphanDrafts(gitlab, project, mr);

  if (fresh.length === 0) {
    return {
      posted: 0,
      drafts: { abandoned, created: 0, deletedPrePublish: 0, published: 0, publishFailed: 0 },
    };
  }

  let drafts: DraftRecord[];
  try {
    drafts = await createDraftsConcurrently(gitlab, project, mr, fresh);
  } catch (error) {
    // A draft creation failed mid-flight. Some siblings may have succeeded
    // and now sit as unpublished drafts on the MR — sweep them before
    // re-throwing so the failure does not leak partial state.
    await cleanupOrphanDrafts(gitlab, project, mr).catch(() => undefined);
    throw error;
  }

  const survivors = await deleteRaceLosers(gitlab, project, mr, drafts);
  const deletedPrePublish = drafts.length - survivors.length;

  const { published, publishFailed } = await publishDrafts(gitlab, project, mr, survivors);

  return {
    posted: published,
    drafts: { abandoned, created: drafts.length, deletedPrePublish, published, publishFailed },
  };
}

/**
 * Publishes the surviving drafts. `bulk_publish` is one atomic batch server-side
 * — a single draft with an unresolvable diff position (e.g. a one-sided context
 * line, gitlab-org/gitlab#579609) makes it 500 and nothing publishes. When that
 * happens we fall back to publishing each draft individually, which GitLab
 * isolates per draft, so one bad draft can no longer sink the whole set (and
 * fail the CI job). The original error is re-thrown only when every individual
 * publish also fails, so a genuinely broken run still surfaces loudly.
 */
async function publishDrafts(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  drafts: DraftRecord[],
): Promise<{ published: number; publishFailed: number }> {
  if (drafts.length === 0) return { published: 0, publishFailed: 0 };
  try {
    await gitlab.bulkPublishDraftNotes(project, mr);
    return { published: drafts.length, publishFailed: 0 };
  } catch (bulkError) {
    const results = await Promise.allSettled(
      drafts.map((draft) => gitlab.publishDraftNote(project, mr, draft.id)),
    );
    const published = results.filter((result) => result.status === 'fulfilled').length;
    if (published === 0) throw bulkError;
    return { published, publishFailed: drafts.length - published };
  }
}

async function cleanupOrphanDrafts(
  gitlab: GitLabClient,
  project: string,
  mr: string,
): Promise<number> {
  const me = await gitlab.getCurrentUser();
  const drafts = await gitlab.listDraftNotes(project, mr);
  const mine = drafts.filter((draft) => draft.author_id === me.id);
  if (mine.length === 0) return 0;
  await Promise.all(mine.map((draft) => gitlab.deleteDraftNote(project, mr, draft.id)));
  return mine.length;
}

async function createDraftsConcurrently(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  fresh: GeneratedComment[],
): Promise<DraftRecord[]> {
  const records: DraftRecord[] = Array.from({ length: fresh.length });
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= fresh.length) return;
      const item = fresh[index];
      const draft = await gitlab.createDraftNote(project, mr, item.payload);
      records[index] = { id: draft.id, fingerprints: item.fingerprints };
    }
  }

  const workerCount = Math.min(DRAFT_CONCURRENCY, fresh.length);
  // allSettled (not all) so siblings finish their POSTs before we report
  // failure — that way the caller's cleanup can see every draft GitLab has
  // accepted, not just the ones that beat the rejection.
  const results = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
  return records;
}

/**
 * Deletes drafts whose fingerprints now collide with already-published
 * discussions (a concurrent run won the race) and returns the surviving drafts
 * still safe to publish.
 */
async function deleteRaceLosers(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  drafts: DraftRecord[],
): Promise<DraftRecord[]> {
  const live = extractExistingFingerprints(await gitlab.getDiscussions(project, mr));
  const colliding: DraftRecord[] = [];
  const survivors: DraftRecord[] = [];
  for (const draft of drafts) {
    if (live.has(draft.fingerprints.primary) || live.has(draft.fingerprints.secondary)) {
      colliding.push(draft);
    } else {
      survivors.push(draft);
    }
  }
  if (colliding.length > 0) {
    await Promise.all(colliding.map((draft) => gitlab.deleteDraftNote(project, mr, draft.id)));
  }
  return survivors;
}
