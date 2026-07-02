import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Directory (relative to cwd) where dropped-file diffs are staged for retrieval. */
export const SKIPPED_DIFF_DIR = '.gitlab-review-skipped';

export interface SkippedDiffFile {
  /** Original repository path of the dropped file. */
  path: string;
  /** Path to the staged diff, relative to cwd — what the agent passes to its read tool. */
  diskPath: string;
}

/** Turn a repo path into a safe flat filename that keeps the original readable. */
function slugify(path: string): string {
  return `${path.replace(/[^a-zA-Z0-9._-]/g, '__')}.diff`;
}

/**
 * Write each size-dropped file's diff to `<cwd>/.gitlab-review-skipped/` so an
 * agentic reviewer can read the diffs it deems highest-risk on demand, instead
 * of the diffs being lost to the char budget. Returns the on-disk manifest.
 * Paths are staged under cwd because the reviewer's read tool is cwd-scoped.
 */
export async function writeSkippedDiffs(
  cwd: string,
  sections: Array<{ path: string; section: string }>,
): Promise<SkippedDiffFile[]> {
  if (sections.length === 0) return [];
  const dir = join(cwd, SKIPPED_DIFF_DIR);
  await mkdir(dir, { recursive: true });
  const files: SkippedDiffFile[] = [];
  for (const { path, section } of sections) {
    const relative = join(SKIPPED_DIFF_DIR, slugify(path));
    await writeFile(join(cwd, relative), section, 'utf8');
    files.push({ path, diskPath: relative });
  }
  return files;
}

/** Remove the staged-diff directory. Safe to call when it was never created. */
export async function cleanupSkippedDiffs(cwd: string): Promise<void> {
  await rm(join(cwd, SKIPPED_DIFF_DIR), { recursive: true, force: true });
}

/**
 * Render the `<skipped_files>` block for the retrieval mode: each dropped file
 * with its on-disk diff path and an instruction to read the highest-risk ones.
 */
export function renderRetrievableSkippedBlock(files: SkippedDiffFile[]): string {
  const list = files.map((f) => `- ${f.path} → ${f.diskPath}`).join('\n');
  return `<skipped_files>\n${list}\n</skipped_files>\nThese files exceeded the inline size budget, so their diffs are NOT in the prompt above — but each is staged on disk at the path shown. Use your file-read tool to open the diffs most likely to contain defects (start with source files over config/tests) and review them as if they were inline. You may not have budget to read them all; say in your summary which you reviewed and which you did not.`;
}
