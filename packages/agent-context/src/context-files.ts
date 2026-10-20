import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { walkDirs } from './paths.js';

/** A context file read from the repository, such as an `AGENTS.md`. */
export interface ContextFile {
  /** Path relative to `cwd`, or the absolute path when it is `cwd` itself. */
  path: string;
  content: string;
}

/** Project convention files, in order of preference within one directory. */
export const CONVENTION_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];

/**
 * Agent configuration directories also searched in each directory, after the
 * directory itself: `.pi/AGENTS.md`, `.claude/CLAUDE.md`, ….
 */
export const CONFIG_DIRS: readonly string[] = ['.pi', '.claude', '.agents'];

/**
 * The first of `filenames` found in `dir` or in one of its `CONFIG_DIRS`.
 * Names match case-insensitively; the directory itself is searched first.
 */
async function readFirstMatch(
  dir: string,
  filenames: readonly string[],
): Promise<{ path: string; content: string } | null> {
  const wanted = new Set(filenames.map((f) => f.toLowerCase()));
  for (const candidate of [dir, ...CONFIG_DIRS.map((d) => join(dir, d))]) {
    let entries: string[];
    try {
      entries = await readdir(candidate);
    } catch {
      continue;
    }
    const match = entries.find((entry) => wanted.has(entry.toLowerCase()));
    if (!match) continue;
    const fullPath = join(candidate, match);
    try {
      const content = await readFile(fullPath, 'utf8');
      return { path: fullPath, content };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Read one context file per directory, from `gitRoot` down to `cwd` (root
 * first), so the closest file comes last and reads as the most specific.
 * In each directory the first match of `filenames` wins, searched in the
 * directory and then in its `CONFIG_DIRS`.
 *
 * Pass `CONVENTION_FILES` for project conventions, or a tool-specific list
 * (code-review passes `['REVIEW.md']` for its review rules).
 */
export async function walkUpContextFiles(
  cwd: string,
  filenames: readonly string[],
  gitRoot: string,
): Promise<ContextFile[]> {
  const result: ContextFile[] = [];
  const seen = new Set<string>();
  for (const dir of walkDirs(cwd, gitRoot)) {
    const file = await readFirstMatch(dir, filenames);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    result.push({ path: relative(cwd, file.path) || file.path, content: file.content });
  }
  return result;
}
