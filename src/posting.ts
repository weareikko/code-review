import type { Discussion, GitLabClient } from './gitlab.js';
import type { Fingerprints, GeneratedComment } from './types.js';

import { extractExistingFingerprints } from './fingerprints.js';

export const SUMMARY_MARKER = '<!-- pi-reviewer:summary -->';
export const SUMMARY_HISTORY_START = '<!-- pi-reviewer:summary-history:start -->';
export const SUMMARY_HISTORY_END = '<!-- pi-reviewer:summary-history:end -->';
export const SUMMARY_HISTORY_ENTRY_START = '<!-- pi-reviewer:summary-history-entry:start -->';
export const SUMMARY_HISTORY_ENTRY_END = '<!-- pi-reviewer:summary-history-entry:end -->';
export const SUMMARY_HISTORY_LIMIT = 10;

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
  const body = `${SUMMARY_MARKER}\n\n${summary.trim()}`;
  const withFooter = costFooter ? `${body}\n\n---\n\n${costFooter}` : body;
  const historyEntries = options.historyEntries?.filter((entry) => entry.trim().length > 0) ?? [];
  if (historyEntries.length === 0) return withFooter;
  return `${withFooter}\n\n${buildSummaryHistoryBlock(historyEntries)}`;
}

export function findExistingSummaryNote(discussions: Discussion[]): SummaryNote | null {
  for (const discussion of discussions) {
    for (const note of discussion.notes ?? []) {
      const id = note.id;
      if (typeof id !== 'number') continue;
      if (typeof note.body === 'string' && note.body.includes(SUMMARY_MARKER)) {
        return { id, body: note.body };
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
  const body = buildSummaryBody(summary, options.costFooter, { historyEntries });
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
