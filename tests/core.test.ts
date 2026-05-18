import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { GitLabClient } from '../src/gitlab.js';
import { appendFingerprintMarkers, buildPayload, extractDiffHunkContext, extractExistingFingerprints, fingerprints, parseReviewMarkdown } from '../src/review.js';

describe('config', () => {
  it('uses GitLab CI env defaults', () => {
    const cfg = resolveConfig([], { CI_PROJECT_ID: '1', CI_MERGE_REQUEST_IID: '2', CI_SERVER_HOST: 'gitlab.example.com', GITLAB_TOKEN: 'tok', PI_API_KEY: 'key' });
    expect(cfg).toMatchObject({ project: '1', mr: '2', gitlabUrl: 'https://gitlab.example.com', gitlabToken: 'tok', model: 'anthropic/claude-sonnet-4-5', minSeverity: 'info', reviewFile: 'pi-review.md', output: 'review-comments.json' });
  });
});

describe('GitLabClient', () => {
  it('constructs API URLs', () => {
    const client = new GitLabClient({ gitlabUrl: 'https://gitlab.example.com/', token: 't' });
    expect(client.url('/projects/1/merge_requests/2', { page: 1 })).toBe('https://gitlab.example.com/api/v4/projects/1/merge_requests/2?page=1');
  });

  it('paginates without real GitLab', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1 }]), { headers: { 'x-next-page': '2' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }]), { headers: { 'x-next-page': '' } }));
    const client = new GitLabClient({ gitlabUrl: 'https://gitlab.example.com', token: 't', fetchImpl });
    await expect(client.paginate('/items')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('review parsing and deterministic helpers', () => {
  it('parses pi-review markdown inline comments', () => {
    const md = 'Review\n== Inline Comments ==\n🟡 src/a.ts:3 (RIGHT)\nFix this\nacross lines\n\n🔴 old.ts:1 (LEFT)\nRemove it';
    expect(parseReviewMarkdown(md)).toEqual([
      { file: 'src/a.ts', line: 3, side: 'RIGHT', severity: 'warning', body: 'Fix this\nacross lines' },
      { file: 'old.ts', line: 1, side: 'LEFT', severity: 'error', body: 'Remove it' },
    ]);
  });

  it('also parses JSON comment blocks', () => {
    const md = '```json\n{"comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix this"}]}\n```';
    expect(parseReviewMarkdown(md)).toEqual([{ file: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Fix this' }]);
  });

  it('extracts diff hunk context', () => {
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n a\n+new\n b';
    expect(extractDiffHunkContext(diff, 'src/a.ts', 2, 'RIGHT')).toContain('+new');
  });

  it('generates stable fingerprints', () => {
    const c = { file: 'src/a.ts', line: 2, side: 'RIGHT' as const, body: 'Fix   this' };
    expect(fingerprints(c, 'hunk')).toEqual(fingerprints({ ...c, body: 'Fix this' }, 'hunk'));
  });

  it('detects duplicate fingerprint markers', () => {
    const fp = fingerprints({ file: 'a', line: 1, side: 'RIGHT', body: 'Body' }, 'hunk');
    const body = appendFingerprintMarkers('Body', fp);
    const existing = extractExistingFingerprints([{ notes: [{ body }] }]);
    expect(existing.has(fp.primary)).toBe(true);
    expect(existing.has(fp.secondary)).toBe(true);
  });

  it('builds GitLab payloads with left/right lines', () => {
    const refs = { base_sha: 'base', start_sha: 'start', head_sha: 'head' };
    expect(buildPayload({ file: 'f.js', line: 42, side: 'RIGHT', body: 'b' }, 'b', refs).position).toMatchObject({ new_line: 42, new_path: 'f.js' });
    expect(buildPayload({ file: 'f.js', line: 5, side: 'LEFT', body: 'b' }, 'b', refs).position).toMatchObject({ old_line: 5, old_path: 'f.js' });
  });
});
