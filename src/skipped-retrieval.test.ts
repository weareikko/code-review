import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSkippedDiffs,
  renderRetrievableSkippedBlock,
  SKIPPED_DIFF_DIR,
  writeSkippedDiffs,
} from './skipped-retrieval.js';

describe('skipped-diff retrieval', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('stages each dropped diff under cwd with a readable, path-safe name', async () => {
    dir = await mkdtemp(join(tmpdir(), 'skip-'));
    const sections = [
      { path: 'src/pay/checkout.ts', section: 'diff --git a/src/pay/checkout.ts ...\n+bug\n' },
      { path: 'src/util.ts', section: 'diff --git a/src/util.ts ...\n+x\n' },
    ];
    const files = await writeSkippedDiffs(dir, sections);

    expect(files).toHaveLength(2);
    // relative paths, under the staging dir, path separators flattened
    expect(files[0].diskPath.startsWith(SKIPPED_DIFF_DIR)).toBe(true);
    expect(files[0].diskPath).not.toContain('/src/'); // slashes flattened in the filename
    // content is written and readable at diskPath
    const body = await readFile(join(dir, files[0].diskPath), 'utf8');
    expect(body).toContain('+bug');
    // original path is preserved in the manifest for the prompt
    expect(files.map((f) => f.path)).toEqual(['src/pay/checkout.ts', 'src/util.ts']);
  });

  it('writes nothing for an empty section list', async () => {
    dir = await mkdtemp(join(tmpdir(), 'skip-'));
    expect(await writeSkippedDiffs(dir, [])).toEqual([]);
  });

  it('cleanup removes the staging directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'skip-'));
    await writeSkippedDiffs(dir, [{ path: 'a.ts', section: 'diff\n+a\n' }]);
    await cleanupSkippedDiffs(dir);
    await expect(stat(join(dir, SKIPPED_DIFF_DIR))).rejects.toThrow();
  });

  it('renders a retrieval block with on-disk paths and a read instruction', () => {
    const block = renderRetrievableSkippedBlock([
      { path: 'src/a.ts', diskPath: '.gitlab-review-skipped/src__a.ts.diff' },
    ]);
    expect(block).toContain('<skipped_files>');
    expect(block).toContain('src/a.ts → .gitlab-review-skipped/src__a.ts.diff');
    expect(block.toLowerCase()).toContain('read tool');
  });
});
