import nodeFs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitTools } from './git-tool.js';

// Hermetic: builds a real git repo on disk with isomorphic-git. No network, no
// system git binary, no LLM.
describe('createGitTools', () => {
  let dir: string;
  let firstOid: string;
  let secondOid: string;
  const author = { name: 'Tester', email: 't@example.com' };

  const runText = async (tool: { execute: Function }, params: unknown): Promise<string> => {
    const result = await tool.execute('id', params);
    return result.content.map((c: { text: string }) => c.text).join('\n');
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'git-tool-'));
    await git.init({ fs: nodeFs, dir, defaultBranch: 'main' });

    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    await git.add({ fs: nodeFs, dir, filepath: 'a.ts' });
    firstOid = await git.commit({ fs: nodeFs, dir, message: 'feat: add a', author });

    await writeFile(join(dir, 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(dir, 'b.ts'), 'export const b = "new file";\n');
    await git.add({ fs: nodeFs, dir, filepath: 'a.ts' });
    await git.add({ fs: nodeFs, dir, filepath: 'b.ts' });
    secondOid = await git.commit({ fs: nodeFs, dir, message: 'feat: bump a and add b', author });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('git_log lists commits newest first', async () => {
    const [gitLog] = createGitTools(dir);
    const out = await runText(gitLog, {});
    expect(out).toContain('feat: bump a and add b');
    expect(out).toContain('feat: add a');
    expect(out.indexOf('bump a')).toBeLessThan(out.indexOf('add a'));
  });

  it('git_log since a ref lists only newer commits', async () => {
    const [gitLog] = createGitTools(dir);
    const out = await runText(gitLog, { since: firstOid });
    expect(out).toContain('feat: bump a and add b');
    expect(out).not.toContain('feat: add a');
  });

  it('git_show renders the commit message and a unified diff vs the parent', async () => {
    const [, gitShow] = createGitTools(dir);
    const out = await runText(gitShow, { ref: secondOid });
    expect(out).toContain('feat: bump a and add b');
    // a.ts modified, b.ts added.
    expect(out).toContain('a/a.ts');
    expect(out).toContain('-export const a = 1;');
    expect(out).toContain('+export const a = 2;');
    expect(out).toContain('b/b.ts');
    expect(out).toContain('+export const b = "new file";');
  });

  it('git_show on the root commit diffs against the empty tree', async () => {
    const [, gitShow] = createGitTools(dir);
    const out = await runText(gitShow, { ref: firstOid });
    expect(out).toContain('feat: add a');
    expect(out).toContain('+export const a = 1;');
  });

  it('git_diff renders the diff between two refs', async () => {
    const [, , gitDiff] = createGitTools(dir);
    const out = await runText(gitDiff, { from: firstOid, to: secondOid });
    expect(out).toContain('+export const a = 2;');
    expect(out).toContain('b/b.ts');
  });

  it('rejects refs that are not sha/ref shaped', async () => {
    const [, gitShow] = createGitTools(dir);
    await expect(runText(gitShow, { ref: 'a; rm -rf /' })).rejects.toThrow(/Invalid git ref/);
  });

  it('returns no tools when the directory is not a git repository', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'not-a-repo-'));
    try {
      expect(createGitTools(bare)).toEqual([]);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
