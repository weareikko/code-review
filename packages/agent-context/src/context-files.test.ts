import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONVENTION_FILES, walkUpContextFiles } from './context-files.js';

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('walkUpContextFiles', () => {
  it('reads one file per directory from the git root down to cwd, root first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-'));
    const cwd = join(root, 'packages', 'web');
    await write(join(root, 'AGENTS.md'), 'root');
    await write(join(root, 'packages', 'CLAUDE.md'), 'packages');
    await write(join(cwd, 'AGENTS.md'), 'web');

    const files = await walkUpContextFiles(cwd, CONVENTION_FILES, root);
    expect(files.map((f) => f.content)).toEqual(['root', 'packages', 'web']);
    expect(files.map((f) => f.path)).toEqual([
      join('..', '..', 'AGENTS.md'),
      join('..', 'CLAUDE.md'),
      'AGENTS.md',
    ]);
  });

  it('prefers the first listed name when a directory has several', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-'));
    await write(join(root, 'CLAUDE.md'), 'claude');
    await write(join(root, 'AGENTS.md'), 'agents');

    const files = await walkUpContextFiles(root, CONVENTION_FILES, root);
    expect(files.map((f) => f.content)).toEqual(['agents']);
  });

  it('matches names case-insensitively', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-'));
    await write(join(root, 'agents.md'), 'lower');

    const files = await walkUpContextFiles(root, CONVENTION_FILES, root);
    expect(files.map((f) => f.content)).toEqual(['lower']);
  });

  it('falls back to the agent configuration directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-'));
    await write(join(root, '.claude', 'CLAUDE.md'), 'in .claude');

    const files = await walkUpContextFiles(root, CONVENTION_FILES, root);
    expect(files).toEqual([{ path: join('.claude', 'CLAUDE.md'), content: 'in .claude' }]);
  });

  it('reads a tool-specific file list, such as review rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-'));
    await write(join(root, 'AGENTS.md'), 'conventions');
    await write(join(root, 'REVIEW.md'), 'rules');

    const files = await walkUpContextFiles(root, ['REVIEW.md'], root);
    expect(files.map((f) => f.content)).toEqual(['rules']);
  });

  it('returns nothing when no directory holds a match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-'));
    expect(await walkUpContextFiles(root, CONVENTION_FILES, root)).toEqual([]);
  });
});
