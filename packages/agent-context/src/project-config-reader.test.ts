import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors.js';
import { git } from './git.js';
import {
  GitRevisionProjectConfigReader,
  WorkingTreeProjectConfigReader,
} from './project-config-reader.js';

async function makeGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project-config-reader-'));
  await git(['init'], { cwd: root });
  return root;
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(['add', '.'], { cwd: root });
  await git(
    ['-c', 'user.name=Acme Bot', '-c', 'user.email=bot@acme.test', 'commit', '-m', message],
    { cwd: root },
  );
}

describe('WorkingTreeProjectConfigReader', () => {
  it('reads UTF-8 files relative to the repository root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-config-reader-'));
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'settings.json'), '{"name":"café"}\n', 'utf8');

    const reader = new WorkingTreeProjectConfigReader(root);

    await expect(reader.read('.claude/settings.json')).resolves.toBe('{"name":"café"}\n');
    await expect(reader.read('.claude/missing.json')).resolves.toBeUndefined();
  });

  it.each(['/etc/passwd', '../outside.json', 'config/../../outside.json', 'C:\\config.json'])(
    'rejects path %s',
    async (path) => {
      const reader = new WorkingTreeProjectConfigReader('/repo');
      await expect(reader.read(path)).rejects.toBeInstanceOf(ConfigError);
    },
  );
});

describe('GitRevisionProjectConfigReader', () => {
  it('freezes a revision and reads blobs without changing Git state', async () => {
    const root = await makeGitRepo();
    await writeFile(join(root, '.mcp.json'), 'version one\n', 'utf8');
    await commitAll(root, 'version one');

    const reader = await GitRevisionProjectConfigReader.create(root, 'HEAD');
    const frozenCommit = reader.commit;

    await writeFile(join(root, '.mcp.json'), 'version two\n', 'utf8');
    await commitAll(root, 'version two');
    await writeFile(join(root, '.mcp.json'), 'working tree\n', 'utf8');
    await writeFile(join(root, 'staged.txt'), 'staged\n', 'utf8');
    await git(['add', 'staged.txt'], { cwd: root });

    const headBefore = await git(['rev-parse', 'HEAD'], { cwd: root });
    const statusBefore = await git(['status', '--short'], { cwd: root });

    await expect(reader.read('.mcp.json')).resolves.toBe('version one\n');
    await expect(reader.read('missing.json')).resolves.toBeUndefined();

    expect(reader.commit).toBe(frozenCommit);
    expect(await git(['rev-parse', 'HEAD'], { cwd: root })).toBe(headBefore);
    expect(await git(['status', '--short'], { cwd: root })).toBe(statusBefore);
  });
});
