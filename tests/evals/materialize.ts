/**
 * Materialize a synthetic review into a real on-disk git repository so the
 * commit-exploration input mode (Mode C) has actual history for its git tools to
 * walk. Uses isomorphic-git (no system git binary), committing the generator's
 * per-commit file partition in order.
 */

import nodeFs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as git from 'isomorphic-git';
import type { SyntheticReview } from './synthetic.js';

export interface MaterializedRepo {
  dir: string;
  /** Commit oids in creation order (oldest first). */
  oids: string[];
}

export async function materializeRepo(review: SyntheticReview): Promise<MaterializedRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'input-mode-repo-'));
  await git.init({ fs: nodeFs, dir, defaultBranch: 'main' });
  const contentByPath = new Map(review.files.map((f) => [f.path, f.content]));
  const author = { name: 'Fixture', email: 'fixture@example.com' };
  const oids: string[] = [];

  for (const commit of review.commits) {
    for (const path of commit.files) {
      const abs = join(dir, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, contentByPath.get(path) ?? '', 'utf8');
      await git.add({ fs: nodeFs, dir, filepath: path });
    }
    const oid = await git.commit({ fs: nodeFs, dir, message: commit.message, author });
    oids.push(oid);
  }

  return { dir, oids };
}
