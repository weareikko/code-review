import type { Discussion, GitLabClient } from './gitlab.js';
import type { Fingerprints, GeneratedComment } from './types.js';

import { extractExistingFingerprints } from './fingerprints.js';

export const SUMMARY_MARKER = '<!-- gitlab-review:summary -->';
export const SUMMARY_HISTORY_START = '<!-- gitlab-review:summary-history:start -->';
export const SUMMARY_HISTORY_END = '<!-- gitlab-review:summary-history:end -->';
export const SUMMARY_HISTORY_ENTRY_START = '<!-- gitlab-review:summary-history-entry:start -->';
export const SUMMARY_HISTORY_ENTRY_END = '<!-- gitlab-review:summary-history-entry:end -->';
export const SUMMARY_HISTORY_LIMIT = 10;
const LEGACY_PROJECT_MARKER = ['pi', 'reviewer'].join('-');
const LEGACY_SUMMARY_MARKER = `<!-- ${LEGACY_PROJECT_MARKER}:summary -->`;
const LEGACY_SUMMARY_HISTORY_START = `<!-- ${LEGACY_PROJECT_MARKER}:summary-history:start -->`;
const LEGACY_SUMMARY_HISTORY_END = `<!-- ${LEGACY_PROJECT_MARKER}:summary-history:end -->`;
const LEGACY_SUMMARY_HISTORY_ENTRY_START = `<!-- ${LEGACY_PROJECT_MARKER}:summary-history-entry:start -->`;
const LEGACY_SUMMARY_HISTORY_ENTRY_END = `<!-- ${LEGACY_PROJECT_MARKER}:summary-history-entry:end -->`;
const SUMMARY_MARKERS = [SUMMARY_MARKER, LEGACY_SUMMARY_MARKER] as const;
const SUMMARY_HISTORY_MARKER_PAIRS = [
  { start: SUMMARY_HISTORY_START, end: SUMMARY_HISTORY_END },
  { start: LEGACY_SUMMARY_HISTORY_START, end: LEGACY_SUMMARY_HISTORY_END },
] as const;
const SUMMARY_HISTORY_ENTRY_MARKER_PAIRS = [
  { start: SUMMARY_HISTORY_ENTRY_START, end: SUMMARY_HISTORY_ENTRY_END },
  { start: LEGACY_SUMMARY_HISTORY_ENTRY_START, end: LEGACY_SUMMARY_HISTORY_ENTRY_END },
] as const;
const REVIEWED_COMMIT_PROJECT_RE = String.raw`(?:gitlab-review|${LEGACY_PROJECT_MARKER})`;
export const REVIEWED_COMMIT_FOOTER_PATTERN = new RegExp(
  String.raw`Reviewed by \[@ikko-dev\/${REVIEWED_COMMIT_PROJECT_RE}\]\(https:\/\/github\.com\/ikko-dev\/${REVIEWED_COMMIT_PROJECT_RE}\) for commit ([a-f0-9]{40})\.`,
  'i',
);

export type SummaryAction = 'created' | 'updated';

export interface SummaryResult {
  action: SummaryAction;
  noteId?: number;
}

export interface SummaryNote {
  id: number;
  body: string;
}

export interface SummaryBodyOptions {
  historyEntries?: string[];
  reviewedCommitSha?: string;
  skillsFooter?: string;
}

export interface UpsertSummaryOptions extends SummaryBodyOptions {
  archivedAt?: Date;
  costFooter?: string;
}

export function buildSummaryBody(
  summary: string,
  costFooter?: string,
  options: SummaryBodyOptions = {},
): string {
  const body = `${SUMMARY_MARKER}\n\n## Code Review\n\n${summary.trim()}`;
  const footerLines = [
    costFooter?.trim(),
    options.skillsFooter?.trim(),
    options.reviewedCommitSha ? buildReviewedCommitFooter(options.reviewedCommitSha) : undefined,
  ].filter((line): line is string => Boolean(line));
  const withFooter =
    footerLines.length > 0 ? `${body}\n\n---\n\n${footerLines.join('\n\n')}` : body;
  const historyEntries = options.historyEntries?.filter((entry) => entry.trim().length > 0) ?? [];
  if (historyEntries.length === 0) return withFooter;
  return `${withFooter}\n\n${buildSummaryHistoryBlock(historyEntries)}`;
}

export function buildReviewedCommitFooter(commitSha: string): string {
  return `Reviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) for commit ${commitSha}.`;
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
      if (typeof body === 'string' && SUMMARY_MARKERS.some((marker) => body.includes(marker))) {
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
  for (const markers of SUMMARY_HISTORY_ENTRY_MARKER_PAIRS) {
    const entryPattern = new RegExp(
      `${escapeRegExp(markers.start)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(markers.end)}`,
      'g',
    );
    for (const match of body.matchAll(entryPattern)) {
      const entry = match[1]?.trim();
      if (entry)
        entries.push(`${SUMMARY_HISTORY_ENTRY_START}\n${entry}\n${SUMMARY_HISTORY_ENTRY_END}`);
    }
  }
  return entries;
}

export function stripSummaryHistory(body: string): string {
  const historyMarker = findFirstSummaryHistoryMarker(body);
  if (!historyMarker) return body.trim();

  const { index: start, markers } = historyMarker;
  const detailsStart = body.lastIndexOf('<details>', start);
  const blockStart = detailsStart === -1 ? start : detailsStart;
  const endMarkerStart = body.indexOf(markers.end, start);
  const endMarkerEnd =
    endMarkerStart === -1 ? start + markers.start.length : endMarkerStart + markers.end.length;
  const detailsEnd = body.indexOf('</details>', endMarkerEnd);
  const blockEnd = detailsEnd === -1 ? endMarkerEnd : detailsEnd + '</details>'.length;

  return `${body.slice(0, blockStart)}${body.slice(blockEnd)}`.trim();
}

export function stripSummaryMarker(body: string): string {
  let stripped = body;
  for (const marker of SUMMARY_MARKERS) stripped = stripped.replace(marker, '');
  return stripped.trim();
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
  });
  if (existing) {
    await gitlab.updateMergeRequestNote(project, mr, existing.id, body);
    return { action: 'updated', noteId: existing.id };
  }
  const created = await gitlab.createMergeRequestNote(project, mr, body);
  return { action: 'created', noteId: created.id };
}

function findFirstSummaryHistoryMarker(
  body: string,
): { index: number; markers: (typeof SUMMARY_HISTORY_MARKER_PAIRS)[number] } | null {
  let first: { index: number; markers: (typeof SUMMARY_HISTORY_MARKER_PAIRS)[number] } | null =
    null;
  for (const markers of SUMMARY_HISTORY_MARKER_PAIRS) {
    const index = body.indexOf(markers.start);
    if (index !== -1 && (!first || index < first.index)) first = { index, markers };
  }
  return first;
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
      drafts: { abandoned, created: 0, deletedPrePublish: 0, published: 0 },
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

  const deletedPrePublish = await deleteRaceLosers(gitlab, project, mr, drafts);
  const published = drafts.length - deletedPrePublish;

  if (published > 0) await gitlab.bulkPublishDraftNotes(project, mr);

  return {
    posted: published,
    drafts: { abandoned, created: drafts.length, deletedPrePublish, published },
  };
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

async function deleteRaceLosers(
  gitlab: GitLabClient,
  project: string,
  mr: string,
  drafts: DraftRecord[],
): Promise<number> {
  const live = extractExistingFingerprints(await gitlab.getDiscussions(project, mr));
  const colliding = drafts.filter(
    (draft) => live.has(draft.fingerprints.primary) || live.has(draft.fingerprints.secondary),
  );
  if (colliding.length === 0) return 0;
  await Promise.all(colliding.map((draft) => gitlab.deleteDraftNote(project, mr, draft.id)));
  return colliding.length;
}
