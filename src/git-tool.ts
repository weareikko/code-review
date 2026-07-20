/**
 * Custom read-only git tools for the reviewer agent (Mode C: commit exploration).
 *
 * The reviewer's default toolbox (`createReadOnlyTools`) has no git access, and a
 * general bash tool is unsafe here — the reviewer processes attacker-controlled
 * MR content with CI credentials in the environment. These tools expose only
 * three read-only operations, backed by isomorphic-git (pure JS, no shell-out,
 * so there is no command-injection surface) and scoped to a single repo dir:
 *
 * - `git_log`: list commits (optionally the range since a base ref).
 * - `git_show`: a commit's message + unified diff against its first parent.
 * - `git_diff`: unified diff between two refs.
 *
 * Ref arguments are validated to sha/ref shapes; nothing is passed to a shell.
 */

import nodeFs from 'node:fs';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createTwoFilesPatch } from 'diff';
import * as git from 'isomorphic-git';
import { Type } from 'typebox';

/** Accept 4-40 hex sha prefixes or conservative ref names (branch/tag/HEAD~n). */
const REF_RE = /^[0-9a-zA-Z._/~^-]{1,120}$/;

const MAX_PATCH_BYTES = 200_000;

function assertRef(ref: string): void {
  if (!REF_RE.test(ref)) {
    throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`);
  }
}

function text(body: string): { content: { type: 'text'; text: string }[]; details: undefined } {
  return { content: [{ type: 'text', text: body }], details: undefined };
}

interface GitToolOptions {
  /** Injectable fs for hermetic tests; defaults to node:fs. */
  fs?: typeof nodeFs;
}

async function resolveOid(dir: string, fs: typeof nodeFs, ref: string): Promise<string> {
  assertRef(ref);
  return git.resolveRef({ fs, dir, ref }).catch(() => git.expandOid({ fs, dir, oid: ref }));
}

function decode(data: Uint8Array): string | null {
  // Treat NUL-containing blobs as binary and skip — a unified diff of binary is
  // noise and can blow the size budget.
  if (data.includes(0)) return null;
  return Buffer.from(data).toString('utf8');
}

async function readFileAt(
  dir: string,
  fs: typeof nodeFs,
  oid: string,
  filepath: string,
): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath });
    return decode(blob);
  } catch {
    return null; // absent on that side
  }
}

/** Unified diff of every changed file between two commit oids. */
async function diffCommits(
  dir: string,
  fs: typeof nodeFs,
  oldOid: string | null,
  newOid: string,
): Promise<string> {
  const trees = oldOid
    ? [git.TREE({ ref: oldOid }), git.TREE({ ref: newOid })]
    : [git.TREE({ ref: newOid })];
  const changed: string[] = await git.walk({
    fs,
    dir,
    trees,
    map: async (filepath, entries) => {
      if (filepath === '.') return undefined;
      if (!oldOid) {
        const [b] = entries;
        return b && (await b.type()) === 'blob' ? filepath : undefined;
      }
      const [a, b] = entries;
      const aOid = a ? await a.oid() : undefined;
      const bOid = b ? await b.oid() : undefined;
      if (aOid === bOid) return undefined;
      const aType = a ? await a.type() : undefined;
      const bType = b ? await b.type() : undefined;
      if (aType === 'tree' || bType === 'tree') return undefined; // recurse into dirs
      return filepath;
    },
  });

  const patches: string[] = [];
  for (const filepath of changed.sort()) {
    const before = oldOid ? ((await readFileAt(dir, fs, oldOid, filepath)) ?? '') : '';
    const after = (await readFileAt(dir, fs, newOid, filepath)) ?? '';
    if (before === after) continue; // binary-skipped or no textual change
    patches.push(createTwoFilesPatch(`a/${filepath}`, `b/${filepath}`, before, after));
    if (patches.join('\n').length > MAX_PATCH_BYTES) {
      patches.push(
        `\n[diff truncated at ${MAX_PATCH_BYTES} bytes — open the file directly for the rest]`,
      );
      break;
    }
  }
  return patches.join('\n') || '(no textual changes)';
}

/**
 * Build the read-only git tools scoped to `dir` (the repo root). Returns an empty
 * array when `dir` is not a git repository, so callers can wire it
 * unconditionally.
 */
export function createGitTools(dir: string, options: GitToolOptions = {}): AgentTool[] {
  const fs = options.fs ?? nodeFs;
  // Only offer the git tools when `dir` is actually a git repository (a `.git`
  // dir or worktree file). Lets callers wire them unconditionally: present at a
  // real repo root, absent when reviewing a bare diff with no checkout.
  if (!fs.existsSync(join(dir, '.git'))) return [];

  const gitLog = {
    name: 'git_log',
    label: 'git log',
    description:
      'List commits in this repository (newest first). Optionally pass `since` (a ref/sha) to list only commits after it — the range you have not reviewed yet.',
    parameters: Type.Object({
      since: Type.Optional(
        Type.String({ description: 'Only list commits after this ref/sha (exclusive).' }),
      ),
      maxCount: Type.Optional(
        Type.Number({ description: 'Maximum number of commits to return (default 50).' }),
      ),
    }),
    async execute(_id: string, params: { since?: string; maxCount?: number }) {
      const depth = Math.min(Math.max(params.maxCount ?? 50, 1), 500);
      const commits = await git.log({ fs, dir, depth });
      let stop = -1;
      if (params.since) {
        const sinceOid = await resolveOid(dir, fs, params.since);
        stop = commits.findIndex((c) => c.oid === sinceOid || c.oid.startsWith(sinceOid));
      }
      const list = (stop >= 0 ? commits.slice(0, stop) : commits).map((c) => {
        const subject = c.commit.message.split('\n', 1)[0];
        return `${c.oid.slice(0, 10)}  ${subject}  (${c.commit.author.name})`;
      });
      return text(list.length ? list.join('\n') : '(no commits in range)');
    },
  };

  const gitShow = {
    name: 'git_show',
    label: 'git show',
    description:
      "Show a commit's message and its unified diff against its first parent. Pass `ref` (a sha or ref).",
    parameters: Type.Object({
      ref: Type.String({ description: 'The commit sha or ref to show.' }),
    }),
    async execute(_id: string, params: { ref: string }) {
      const oid = await resolveOid(dir, fs, params.ref);
      const { commit } = await git.readCommit({ fs, dir, oid });
      const parent = commit.parent[0] ?? null;
      const diff = await diffCommits(dir, fs, parent, oid);
      return text(
        `commit ${oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\n\n${commit.message.trim()}\n\n${diff}`,
      );
    },
  };

  const gitDiff = {
    name: 'git_diff',
    label: 'git diff',
    description: 'Unified diff between two refs/shas. Pass `from` and `to`.',
    parameters: Type.Object({
      from: Type.String({ description: 'Base ref/sha.' }),
      to: Type.String({ description: 'Target ref/sha.' }),
    }),
    async execute(_id: string, params: { from: string; to: string }) {
      const fromOid = await resolveOid(dir, fs, params.from);
      const toOid = await resolveOid(dir, fs, params.to);
      return text(await diffCommits(dir, fs, fromOid, toOid));
    },
  };

  return [gitLog, gitShow, gitDiff] as unknown as AgentTool[];
}
