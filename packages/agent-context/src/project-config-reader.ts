import { readFile } from 'node:fs/promises';
import { join, posix, resolve, win32 } from 'node:path';
import { ConfigError } from './errors.js';
import { git } from './git.js';

/** Reads UTF-8 configuration files by repository-relative path. */
export interface ProjectConfigReader {
  /** Immutable commit used for reads, when the reader is bound to one. */
  readonly commitSha?: string;
  /** Return the file contents, or `undefined` when the path does not exist. */
  read(path: string): Promise<string | undefined>;
}

function normalizeProjectConfigPath(path: string): string {
  const segments = path.split(/[\\/]/);
  if (!path || posix.isAbsolute(path) || win32.parse(path).root !== '' || segments.includes('..')) {
    throw new ConfigError(`Invalid project configuration path: "${path}"`, {
      hint: 'Use a path relative to the repository root without ".." segments.',
    });
  }

  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!normalized) {
    throw new ConfigError(`Invalid project configuration path: "${path}"`, {
      hint: 'Use a path relative to the repository root.',
    });
  }
  return normalized;
}

function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Reads project configuration from the current working tree. */
export class WorkingTreeProjectConfigReader implements ProjectConfigReader {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async read(path: string): Promise<string | undefined> {
    const normalized = normalizeProjectConfigPath(path);
    try {
      return await readFile(join(this.root, ...normalized.split('/')), 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }
}

/** Reads project configuration from the commit captured for a Git revision. */
export class GitRevisionProjectConfigReader implements ProjectConfigReader {
  readonly root: string;
  readonly commitSha: string;

  private constructor(root: string, commitSha: string) {
    this.root = root;
    this.commitSha = commitSha;
  }

  /** Resolve `revision` to one commit now, so later reads cannot follow a moving ref. */
  static async create(root: string, revision: string): Promise<GitRevisionProjectConfigReader> {
    const resolvedRoot = resolve(root);
    const commit = (
      await git(['rev-parse', '--verify', `${revision}^{commit}`], { cwd: resolvedRoot })
    )
      .trim()
      .split('\n')[0];
    return new GitRevisionProjectConfigReader(resolvedRoot, commit);
  }

  async read(path: string): Promise<string | undefined> {
    const normalized = normalizeProjectConfigPath(path);
    const entry = await git(
      ['ls-tree', '-z', this.commitSha, '--', `:(top,literal)${normalized}`],
      {
        cwd: this.root,
      },
    );
    const match = /^[0-7]{6} blob ([0-9a-f]+)\t/.exec(entry);
    if (!match) return undefined;
    return git(['cat-file', 'blob', match[1]], { cwd: this.root });
  }
}
