import { dirname, sep } from 'node:path';

/** Normalize a filesystem-relative path to the POSIX form used in URLs. */
export function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * Directories from `gitRoot` down to `cwd`, inclusive, root first. Callers that
 * read one file per directory and let a later write win get "closest to `cwd`
 * wins" for free. When `cwd` is not under `gitRoot`, the walk stops at the
 * filesystem root.
 */
export function walkDirs(cwd: string, gitRoot: string): string[] {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.unshift(current);
    if (current === gitRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}
