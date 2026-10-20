import { isAbsolute, relative, resolve } from 'node:path';

/** The minimum a loaded skill must expose to attribute a file read to it. */
export interface SkillReadTarget {
  name: string;
  /** Absolute path to the skill directory. Reads under it count as skill reads. */
  rootDir: string;
}

/**
 * The path a built-in read tool call targets, or `undefined` for any other tool
 * or a call with no usable `path`. The parameter name is `path`, matching the
 * `read` tool from `createReadOnlyTools` that the reviewer is actually handed.
 * Only the built-in read tool is considered: a skill is loaded by reading its
 * `SKILL.md`, and every other tool (grep, git, MCP) says nothing about whether
 * the reviewer read the skill.
 */
export function readToolPath(toolName: string, args: unknown): string | undefined {
  if (toolName !== 'Read' && toolName !== 'read') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const filePath = (args as Record<string, unknown>).path;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined;
}

/**
 * The skill whose directory contains `path`, or `undefined` when the read
 * targeted something else. Any file under the skill root counts — a reference
 * file the `SKILL.md` points at is as much a skill read as the `SKILL.md`
 * itself. Relative paths resolve against `cwd` — the review working directory
 * the reviewer's read tool resolves them against, which `--cwd` can move away
 * from the process working directory.
 */
export function findSkillForPath(
  skills: readonly SkillReadTarget[],
  path: string,
  cwd: string,
): SkillReadTarget | undefined {
  const target = resolve(cwd, path);
  return skills.find((skill) => {
    const rel = relative(resolve(skill.rootDir), target);
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
  });
}

/** Counts, per skill, how many files under its directory the reviewer read. */
export interface SkillReadCounter {
  /** Feed every tool start; non-read calls and reads outside a skill are ignored. */
  record(toolName: string, args: unknown): void;
  /** Reads recorded for `skill` so far. */
  countFor(skill: SkillReadTarget): number;
}

/**
 * Build a counter shared by every review stage — Find and Verify run different
 * agents over the same tool list, so a skill read in either stage counts.
 */
export function createSkillReadCounter(
  skills: readonly SkillReadTarget[],
  cwd: string,
): SkillReadCounter {
  const counts = new Map<string, number>();
  return {
    record(toolName, args) {
      const path = readToolPath(toolName, args);
      if (!path) return;
      const skill = findSkillForPath(skills, path, cwd);
      if (!skill) return;
      counts.set(skill.rootDir, (counts.get(skill.rootDir) ?? 0) + 1);
    },
    countFor(skill) {
      return counts.get(skill.rootDir) ?? 0;
    },
  };
}

/** Whether a skill was read, as shown in the footer and the usage log line. */
export function formatSkillUsageState(skill: { reads: number }): string {
  return skill.reads > 0 ? 'read' : 'not read';
}

/**
 * How much a server was used, as shown in the footer and the usage log line:
 * a pluralised call count, `unused` for a server that connected but was never
 * called, and `unavailable` for one that failed to connect.
 */
export function formatMcpUsageState(server: {
  status: 'connected' | 'unavailable';
  calls: number;
}): string {
  if (server.status !== 'connected') return 'unavailable';
  if (server.calls <= 0) return 'unused';
  return `${server.calls} call${server.calls === 1 ? '' : 's'}`;
}

/**
 * The end-of-review usage log line, e.g.
 * `Usage: skills code-review (read); MCP github (1 call), docs (unused)`.
 * Each half is omitted when nothing of that kind was configured, and the whole
 * line is `undefined` when neither was.
 */
export function formatReviewUsageSummary(usage: {
  skills: readonly { name: string; reads: number }[];
  mcp: readonly { name: string; status: 'connected' | 'unavailable'; calls: number }[];
}): string | undefined {
  const parts: string[] = [];
  if (usage.skills.length > 0) {
    const skills = usage.skills.map((s) => `${s.name} (${formatSkillUsageState(s)})`).join(', ');
    parts.push(`skills ${skills}`);
  }
  if (usage.mcp.length > 0) {
    const servers = usage.mcp.map((s) => `${s.name} (${formatMcpUsageState(s)})`).join(', ');
    parts.push(`MCP ${servers}`);
  }
  return parts.length > 0 ? `Usage: ${parts.join('; ')}` : undefined;
}
