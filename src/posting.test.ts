import { describe, expect, it, vi } from 'vitest';
import { GitLabApiError } from './errors.js';
import { GitLabClient } from './gitlab.js';
import {
  buildSummaryBody,
  buildSummaryHistoryEntries,
  extractReviewedCommitSha,
  findExistingReviewedCommitSha,
  findExistingSummaryNoteId,
  postGeneratedComments,
  SUMMARY_HISTORY_ENTRY_START,
  SUMMARY_HISTORY_LIMIT,
  SUMMARY_HISTORY_START,
  SUMMARY_MARKER,
  upsertSummaryNote,
} from './posting.js';
import type { GeneratedComment } from './review.js';

declare const __PKG_VERSION__: string;

describe('summary note upsert', () => {
  it('wraps the summary with the hidden marker on its own line', () => {
    const body = buildSummaryBody('Looks good. **Nice work.**');
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain('Looks good. **Nice work.**');
  });

  it('always includes a level-2 Code Review title for easy identification', () => {
    const body = buildSummaryBody('Looks good.');
    expect(body).toContain('## Code Review');
    const markerIndex = body.indexOf(SUMMARY_MARKER);
    const titleIndex = body.indexOf('## Code Review');
    expect(titleIndex).toBeGreaterThan(markerIndex);
  });

  it('appends cost footer after a horizontal rule when provided', () => {
    const body = buildSummaryBody('Great work.', 'Review usage: 100 in / 50 out — $0.0012 (model)');
    expect(body).toContain('Great work.');
    expect(body).toContain('---');
    expect(body).toContain('Review usage: 100 in / 50 out — $0.0012 (model)');
    const summaryIndex = body.indexOf('Great work.');
    const footerIndex = body.indexOf('Review usage:');
    expect(footerIndex).toBeGreaterThan(summaryIndex);
  });

  it('appends the run ID footnote when provided', () => {
    const id = 'a1b2c3d4-0000-0000-0000-000000000000';
    const body = buildSummaryBody('Great work.', undefined, { runId: id });
    expect(body).toContain(`<sub>Run ID: \`${id}\`</sub>`);
  });

  it('appends and extracts the reviewed commit footer', () => {
    const commit = '27dab603346bcb994190042029ce7368021ff21e';
    const body = buildSummaryBody('Great work.', undefined, { reviewedCommitSha: commit });

    expect(body).toContain(
      `---\n\nReviewed by [@ikko-dev/gitlab-review](https://github.com/ikko-dev/gitlab-review) v${__PKG_VERSION__} for commit 27dab603346bcb994190042029ce7368021ff21e.`,
    );
    expect(extractReviewedCommitSha(body)).toBe(commit);
  });

  it('finds the reviewed commit from the current summary note', () => {
    const current = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const older = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const discussions = [
      {
        notes: [
          {
            id: 12,
            body: buildSummaryBody('current', undefined, {
              reviewedCommitSha: current,
              historyEntries: [buildSummaryBody('older', undefined, { reviewedCommitSha: older })],
            }),
          },
        ],
      },
    ];

    expect(findExistingReviewedCommitSha(discussions)).toBe(current);
  });

  it('ignores reviewed commit footers from archived summary history', () => {
    const older = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const discussions = [
      {
        notes: [
          {
            id: 12,
            body: buildSummaryBody('current without footer', undefined, {
              historyEntries: [buildSummaryBody('older', undefined, { reviewedCommitSha: older })],
            }),
          },
        ],
      },
    ];

    expect(findExistingReviewedCommitSha(discussions)).toBeNull();
  });

  it('finds the existing summary note by marker across discussions', () => {
    const discussions = [
      { notes: [{ id: 1, body: 'inline comment <!-- gitlab-review:fingerprint-primary:abc -->' }] },
      {
        notes: [
          { id: 12, body: `${SUMMARY_MARKER}\n\nprevious summary` },
          { id: 13, body: 'reply' },
        ],
      },
    ];
    expect(findExistingSummaryNoteId(discussions)).toBe(12);
  });

  it('returns null when no existing summary note is present', () => {
    expect(findExistingSummaryNoteId([{ notes: [{ id: 1, body: 'unrelated' }] }])).toBeNull();
  });

  it('creates a new MR note when no existing summary marker is found', async () => {
    const createMergeRequestNote = vi.fn().mockResolvedValue({ id: 99, body: 'x' });
    const updateMergeRequestNote = vi.fn();
    const gitlab = { createMergeRequestNote, updateMergeRequestNote } as unknown as GitLabClient;

    const result = await upsertSummaryNote(gitlab, 'group/repo', '12', 'fresh summary', []);
    expect(result).toEqual({ action: 'created', noteId: 99 });
    expect(createMergeRequestNote).toHaveBeenCalledTimes(1);
    expect(createMergeRequestNote.mock.calls[0][2]).toContain(SUMMARY_MARKER);
    expect(createMergeRequestNote.mock.calls[0][2]).toContain('fresh summary');
    expect(updateMergeRequestNote).not.toHaveBeenCalled();
  });

  it('updates the existing summary note in place and archives the previous run', async () => {
    const createMergeRequestNote = vi.fn();
    const updateMergeRequestNote = vi.fn().mockResolvedValue({ id: 12, body: 'x' });
    const gitlab = { createMergeRequestNote, updateMergeRequestNote } as unknown as GitLabClient;

    const discussions = [{ notes: [{ id: 12, body: `${SUMMARY_MARKER}\n\nprior summary` }] }];
    const result = await upsertSummaryNote(
      gitlab,
      'group/repo',
      '12',
      'latest summary',
      discussions,
      { archivedAt: new Date('2026-05-19T15:00:00Z') },
    );

    expect(result).toEqual({ action: 'updated', noteId: 12 });
    expect(updateMergeRequestNote).toHaveBeenCalledWith(
      'group/repo',
      '12',
      12,
      expect.stringContaining('latest summary'),
    );
    const updatedBody = updateMergeRequestNote.mock.calls[0][3] as string;
    expect(updatedBody).toContain(SUMMARY_MARKER);
    expect(updatedBody).toContain(SUMMARY_HISTORY_START);
    expect(updatedBody).toContain('<summary>Previous review runs</summary>');
    expect(updatedBody).toContain('### Previous run archived 2026-05-19T15:00:00Z');
    expect(updatedBody).toContain('prior summary');
    expect(updatedBody.indexOf('latest summary')).toBeLessThan(
      updatedBody.indexOf('prior summary'),
    );
    expect(createMergeRequestNote).not.toHaveBeenCalled();
  });

  it('keeps older archived summary runs when updating repeatedly', async () => {
    const existingBody = buildSummaryBody('second summary', 'second cost', {
      historyEntries: [
        buildSummaryHistoryEntries(
          `${SUMMARY_MARKER}\n\nfirst summary`,
          new Date('2026-05-19T14:00:00Z'),
        )[0],
      ],
    });
    const createMergeRequestNote = vi.fn();
    const updateMergeRequestNote = vi.fn().mockResolvedValue({ id: 12, body: 'x' });
    const gitlab = { createMergeRequestNote, updateMergeRequestNote } as unknown as GitLabClient;

    await upsertSummaryNote(
      gitlab,
      'group/repo',
      '12',
      'third summary',
      [{ notes: [{ id: 12, body: existingBody }] }],
      { costFooter: 'third cost', archivedAt: new Date('2026-05-19T15:00:00Z') },
    );

    const updatedBody = updateMergeRequestNote.mock.calls[0][3] as string;
    expect(updatedBody).toContain('third summary');
    expect(updatedBody).toContain('second summary');
    expect(updatedBody).toContain('second cost');
    expect(updatedBody).toContain('first summary');
    expect(updatedBody.indexOf('third summary')).toBeLessThan(
      updatedBody.indexOf('second summary'),
    );
    expect(updatedBody.indexOf('second summary')).toBeLessThan(
      updatedBody.indexOf('first summary'),
    );
    expect(createMergeRequestNote).not.toHaveBeenCalled();
  });

  it('caps archived summary history entries', () => {
    const existingEntries = Array.from(
      { length: SUMMARY_HISTORY_LIMIT + 3 },
      (_, index) =>
        buildSummaryHistoryEntries(
          `${SUMMARY_MARKER}\n\nolder summary ${index}`,
          new Date(`2026-05-19T${String(index).padStart(2, '0')}:00:00Z`),
        )[0],
    );
    const entries = buildSummaryHistoryEntries(
      buildSummaryBody('latest previous summary', undefined, { historyEntries: existingEntries }),
      new Date('2026-05-19T15:00:00Z'),
    );

    expect(entries).toHaveLength(SUMMARY_HISTORY_LIMIT);
    expect(entries[0]).toContain('latest previous summary');
    expect(entries.join('\n')).toContain('older summary 0');
    expect(entries.join('\n')).not.toContain(`older summary ${SUMMARY_HISTORY_LIMIT}`);
    expect(entries.join('\n').split(SUMMARY_HISTORY_ENTRY_START)).toHaveLength(
      SUMMARY_HISTORY_LIMIT + 1,
    );
  });
});

describe('postGeneratedComments strategies', () => {
  const fresh: GeneratedComment = {
    comment: { file: 'a.ts', line: 1, side: 'RIGHT', severity: 'info', body: 'fresh' },
    fingerprints: { primary: 'p1', secondary: 's1' },
    duplicate: false,
    payload: {
      body: 'fresh <!-- gitlab-review:fingerprint-primary:p1 -->',
      position: {
        position_type: 'text',
        base_sha: 'b',
        start_sha: 's',
        head_sha: 'h',
        old_path: 'a.ts',
        new_path: 'a.ts',
        new_line: 1,
      },
    },
  };
  const dup: GeneratedComment = {
    ...fresh,
    comment: { ...fresh.comment, body: 'dup' },
    duplicate: true,
  };

  function clientWith(fetchImpl: ReturnType<typeof vi.fn>) {
    return new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });
  }

  it('returns zero with no API calls when every comment is a duplicate', async () => {
    const fetchImpl = vi.fn();
    const result = await postGeneratedComments(clientWith(fetchImpl), 'p', '1', [dup]);
    expect(result).toEqual({ posted: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('direct mode posts one discussion per fresh comment', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: 'd1' }))));
    const result = await postGeneratedComments(
      clientWith(fetchImpl),
      'p',
      '1',
      [fresh, dup, fresh],
      'direct',
    );
    expect(result).toEqual({ posted: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain('/merge_requests/1/discussions');
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
  });

  const draftA: GeneratedComment = {
    ...fresh,
    fingerprints: { primary: 'aaaa', secondary: 'aabb' },
  };
  const draftB: GeneratedComment = {
    ...fresh,
    fingerprints: { primary: 'bbbb', secondary: 'bbcc' },
  };

  type RouteHandler = (init: RequestInit | undefined) => Response;

  function routeFetch(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
    return vi.fn((url: string, init?: RequestInit) => {
      for (const [pattern, handler] of Object.entries(routes)) {
        const [method, path] = pattern.split(' ');
        if ((init?.method ?? 'GET') === method && url.includes(path)) {
          return Promise.resolve(handler(init));
        }
      }
      throw new Error(`Unrouted: ${init?.method ?? 'GET'} ${url}`);
    });
  }

  it('draft mode: cleans no orphans, creates N drafts, bulk-publishes once', async () => {
    let createdId = 100;
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'GET /discussions': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'POST /draft_notes/bulk_publish': () => new Response(null, { status: 204 }),
      'POST /draft_notes': () => {
        const id = createdId++;
        return new Response(JSON.stringify({ id, author_id: 1, note: 'x' }));
      },
    });

    const result = await postGeneratedComments(
      clientWith(fetchImpl),
      'p',
      '1',
      [draftA, draftB, dup],
      'draft',
    );

    expect(result).toEqual({
      posted: 2,
      drafts: { abandoned: 0, created: 2, deletedPrePublish: 0, published: 2 },
    });
    const calls = fetchImpl.mock.calls.map(
      (call) => `${call[1]?.method ?? 'GET'} ${call[0].replace(/.*\/api\/v4/, '')}`,
    );
    expect(
      calls.filter((c) => c.startsWith('POST') && c.includes('/draft_notes/bulk_publish')),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (c) => c.startsWith('POST') && c.includes('/draft_notes') && !c.includes('bulk_publish'),
      ),
    ).toHaveLength(2);
  });

  it('draft mode: deletes orphan drafts authored by the current user before creating new ones', async () => {
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () =>
        new Response(
          JSON.stringify([
            { id: 7, author_id: 1, note: 'orphan-mine' },
            { id: 8, author_id: 2, note: 'orphan-others' },
          ]),
          { headers: { 'x-next-page': '' } },
        ),
      'DELETE /draft_notes': () => new Response(null, { status: 204 }),
      'GET /discussions': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'POST /draft_notes/bulk_publish': () => new Response(null, { status: 204 }),
      'POST /draft_notes': () => new Response(JSON.stringify({ id: 100, author_id: 1, note: 'x' })),
    });

    const result = await postGeneratedComments(clientWith(fetchImpl), 'p', '1', [draftA], 'draft');

    expect(result.drafts).toMatchObject({ abandoned: 1, created: 1, published: 1 });
    const deletes = fetchImpl.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toContain('/draft_notes/7');

    // Orphan cleanup must complete before any new draft is created.
    const firstOrphanDelete = fetchImpl.mock.calls.findIndex(
      (c) => c[1]?.method === 'DELETE' && c[0].includes('/draft_notes/7'),
    );
    const firstCreate = fetchImpl.mock.calls.findIndex(
      (c) =>
        c[1]?.method === 'POST' && c[0].includes('/draft_notes') && !c[0].includes('bulk_publish'),
    );
    expect(firstOrphanDelete).toBeGreaterThanOrEqual(0);
    expect(firstCreate).toBeGreaterThan(firstOrphanDelete);
  });

  it('draft mode: skips bulk_publish when every draft is race-deleted', async () => {
    let createdId = 100;
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'POST /draft_notes': () =>
        new Response(JSON.stringify({ id: createdId++, author_id: 1, note: 'x' })),
      'GET /discussions': () =>
        new Response(
          JSON.stringify([
            {
              notes: [
                {
                  body: 'collide <!-- gitlab-review:fingerprint-primary:aaaa --> <!-- gitlab-review:fingerprint-secondary:aabb -->',
                },
                {
                  body: 'collide <!-- gitlab-review:fingerprint-primary:bbbb --> <!-- gitlab-review:fingerprint-secondary:bbcc -->',
                },
              ],
            },
          ]),
          { headers: { 'x-next-page': '' } },
        ),
      'DELETE /draft_notes': () => new Response(null, { status: 204 }),
    });

    const result = await postGeneratedComments(
      clientWith(fetchImpl),
      'p',
      '1',
      [draftA, draftB],
      'draft',
    );

    expect(result.posted).toBe(0);
    expect(result.drafts).toMatchObject({ created: 2, deletedPrePublish: 2, published: 0 });
    expect(fetchImpl.mock.calls.filter((c) => c[0].includes('bulk_publish'))).toHaveLength(0);
  });

  it('draft mode: self-heals partial drafts when a create call fails mid-flight', async () => {
    let createsSeen = 0;
    let listsSeen = 0;
    const successfulDraftId = 100;
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () => {
        listsSeen += 1;
        // 1st list: orphan cleanup at run start, empty.
        // 2nd list: self-heal cleanup after the failure, returns the draft
        // we managed to create before the sibling worker failed.
        const body =
          listsSeen === 1 ? [] : [{ id: successfulDraftId, author_id: 1, note: 'partial' }];
        return new Response(JSON.stringify(body), { headers: { 'x-next-page': '' } });
      },
      'POST /draft_notes': () => {
        createsSeen += 1;
        if (createsSeen === 1) {
          return new Response(JSON.stringify({ id: successfulDraftId, author_id: 1, note: 'ok' }));
        }
        return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
      },
      'DELETE /draft_notes': () => new Response(null, { status: 204 }),
    });

    await expect(
      postGeneratedComments(clientWith(fetchImpl), 'p', '1', [draftA, draftB], 'draft'),
    ).rejects.toBeInstanceOf(GitLabApiError);

    // Self-heal ran a second list-and-delete that swept the partial draft.
    expect(listsSeen).toBe(2);
    const deletes = fetchImpl.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toContain(`/draft_notes/${successfulDraftId}`);
    // We never attempted to publish anything.
    expect(fetchImpl.mock.calls.filter((c) => c[0].includes('bulk_publish'))).toHaveLength(0);
  });

  it('draft mode: deletes drafts whose fingerprints collide with newly-published discussions', async () => {
    let createdId = 100;
    const createdToFp = new Map<number, string>();
    const fetchImpl = routeFetch({
      'GET /user': () => new Response(JSON.stringify({ id: 1 })),
      'GET /draft_notes': () =>
        new Response(JSON.stringify([]), { headers: { 'x-next-page': '' } }),
      'POST /draft_notes/bulk_publish': () => new Response(null, { status: 204 }),
      'POST /draft_notes': (init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const id = createdId++;
        const fp = body.note.includes('aaaa') ? 'aaaa' : 'bbbb';
        createdToFp.set(id, fp);
        return new Response(JSON.stringify({ id, author_id: 1, note: body.note }));
      },
      'GET /discussions': () =>
        new Response(
          JSON.stringify([
            {
              notes: [
                {
                  body: 'collision <!-- gitlab-review:fingerprint-primary:aaaa --> <!-- gitlab-review:fingerprint-secondary:aabb -->',
                },
              ],
            },
          ]),
          { headers: { 'x-next-page': '' } },
        ),
      'DELETE /draft_notes': () => new Response(null, { status: 204 }),
    });

    const aWithFp: GeneratedComment = {
      ...draftA,
      payload: { ...draftA.payload, body: 'collision text aaaa' },
    };
    const bWithFp: GeneratedComment = {
      ...draftB,
      payload: { ...draftB.payload, body: 'unique text bbbb' },
    };

    const result = await postGeneratedComments(
      clientWith(fetchImpl),
      'p',
      '1',
      [aWithFp, bWithFp],
      'draft',
    );

    expect(result.drafts).toMatchObject({ created: 2, deletedPrePublish: 1, published: 1 });
    expect(result.posted).toBe(1);
    const deletes = fetchImpl.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    const deletedId = Number(deletes[0][0].match(/draft_notes\/(\d+)/)?.[1]);
    expect(createdToFp.get(deletedId)).toBe('aaaa');
  });
});
