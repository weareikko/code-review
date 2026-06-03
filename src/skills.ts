import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from './errors.js';

export interface Skill {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file. Used to reference skill content in prompts. */
  filePath: string;
  rootDir: string;
  resourceDirs: string[];
  source: 'builtin' | 'project' | 'npm' | 'file';
}

/**
 * A parsed skill spec descriptor. Produced by `parseSkillSpec`.
 *
 * - `builtin`  — bare name resolved from the package's bundled `skills/` dir
 * - `npm`      — package in `node_modules`, optionally with a sub-directory
 * - `file`     — explicit filesystem path (relative or absolute)
 * - `git`      — reserved for Phase 2; not yet supported
 */
export type SkillSpec =
  | { protocol: 'builtin'; name: string }
  | { protocol: 'npm'; packageName: string; subpath: string }
  | { protocol: 'file'; path: string }
  | { protocol: 'git'; url: string; ref: string; subpath: string };

const SKILL_DIRS = ['.agents/skills', '.claude/skills'] as const;
const RESOURCE_DIRS = ['references'] as const;

function parseFrontmatter(content: string): { name: string; description: string } | null {
  // Locate the leading `---` … `---` fence, then hand the inner block to a real
  // YAML parser rather than matching keys with regex. Invalid YAML (e.g. an
  // unquoted value containing `: `) yields null and the skill is skipped.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== 'string' || typeof description !== 'string') return null;
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  if (!trimmedName || !trimmedDescription) return null;
  return { name: trimmedName, description: trimmedDescription };
}

export async function loadSkillFromDir(
  dirPath: string,
  source: Skill['source'],
): Promise<Skill | null> {
  const skillMdPath = join(dirPath, 'SKILL.md');
  let content: string;
  try {
    content = await readFile(skillMdPath, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const resourceDirs = RESOURCE_DIRS.filter((d) => existsSync(join(dirPath, d)));
  return {
    name: parsed.name,
    description: parsed.description,
    filePath: skillMdPath,
    rootDir: dirPath,
    resourceDirs,
    source,
  };
}

export function resolveBuiltinSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
}

export async function loadBuiltinSkill(name: string): Promise<Skill | null> {
  return loadSkillFromDir(join(resolveBuiltinSkillsDir(), name), 'builtin');
}

export async function loadAutoDiscoveredSkills(
  cwd: string,
  gitRoot: string,
  warn?: (msg: string) => void,
): Promise<Skill[]> {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.unshift(current);
    if (current === gitRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Walk gitRoot → cwd so the last write wins (cwd-closest overrides ancestors)
  const found = new Map<string, Skill>();
  for (const dir of dirs) {
    for (const skillDir of SKILL_DIRS) {
      const skillsPath = join(dir, skillDir);
      let entries: string[];
      try {
        entries = await readdir(skillsPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = join(skillsPath, entry);
        const skill = await loadSkillFromDir(entryPath, 'project');
        if (skill) {
          found.set(skill.name, skill);
        } else if (warn && existsSync(join(entryPath, 'SKILL.md'))) {
          warn(
            `Skill at ${entryPath} has a SKILL.md but is missing required frontmatter fields (name, description) — skill not loaded.`,
          );
        }
      }
    }
  }

  return [...found.values()];
}

/**
 * Parse a skill spec string into a typed `SkillSpec` descriptor.
 *
 * Supported spec formats:
 *
 * | Input                              | Result                                            |
 * |------------------------------------|---------------------------------------------------|
 * | `code-review`                      | `{ protocol: 'builtin', name: 'code-review' }`    |
 * | `npm:my-skill`                     | `{ protocol: 'npm', packageName: 'my-skill', ... }`|
 * | `npm:@scope/pkg`                   | `{ protocol: 'npm', packageName: '@scope/pkg', ... }`|
 * | `npm:@scope/bundle/security`       | `{ protocol: 'npm', packageName: '@scope/bundle', subpath: 'security' }`|
 * | `npm:bundle/security`              | `{ protocol: 'npm', packageName: 'bundle', subpath: 'security' }`|
 * | `file:./path/to/skill`             | `{ protocol: 'file', path: './path/to/skill' }`   |
 * | `file:/absolute/path`              | `{ protocol: 'file', path: '/absolute/path' }`    |
 * | `git:https://github.com/org/s.git` | `{ protocol: 'git', ... }` (Phase 2, unsupported) |
 */
export function parseSkillSpec(spec: string): SkillSpec {
  if (spec.startsWith('file:')) {
    return { protocol: 'file', path: spec.slice('file:'.length) };
  }

  if (spec.startsWith('npm:')) {
    const rest = spec.slice('npm:'.length);
    if (rest.startsWith('@')) {
      // Scoped package: @scope/pkg[/subpath...]
      const parts = rest.split('/');
      if (parts.length < 2) {
        // Malformed scoped spec — treat the whole thing as the package name
        return { protocol: 'npm', packageName: rest, subpath: '' };
      }
      const packageName = `${parts[0]}/${parts[1]}`;
      const subpath = parts.slice(2).join('/');
      return { protocol: 'npm', packageName, subpath };
    }
    // Unscoped package: pkg[/subpath...]
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      return { protocol: 'npm', packageName: rest, subpath: '' };
    }
    return {
      protocol: 'npm',
      packageName: rest.slice(0, slashIdx),
      subpath: rest.slice(slashIdx + 1),
    };
  }

  // git: and git+ssh: (and other git+<transport>:// forms)
  if (spec.startsWith('git+') || spec.startsWith('git:')) {
    return parseGitSpec(spec);
  }

  // Bare name → builtin
  return { protocol: 'builtin', name: spec };
}

/**
 * Parse a `git:` / `git+ssh:` skill spec into its URL, pinned ref, and subpath.
 *
 * - `git:<url>`         strips the `git:` marker; what follows is the clone URL
 *   (e.g. `git:https://host/org/repo.git`).
 * - `git+<transport>://…` strips the leading `git+`, leaving a URL git
 *   understands directly (`git+ssh://git@host/…` → `ssh://git@host/…`), matching
 *   npm's `package.json` git-dependency convention.
 *
 * An optional `#<ref>[/<subpath>]` fragment pins the ref (tag, branch, or
 * commit) and, after the first `/`, points at a skill directory inside the repo.
 */
function parseGitSpec(spec: string): Extract<SkillSpec, { protocol: 'git' }> {
  const raw = spec.startsWith('git+') ? spec.slice('git+'.length) : spec.slice('git:'.length);
  const hashIdx = raw.indexOf('#');
  if (hashIdx === -1) {
    return { protocol: 'git', url: raw, ref: '', subpath: '' };
  }
  const url = raw.slice(0, hashIdx);
  const fragment = raw.slice(hashIdx + 1);
  const slashIdx = fragment.indexOf('/');
  if (slashIdx === -1) {
    return { protocol: 'git', url, ref: fragment, subpath: '' };
  }
  return {
    protocol: 'git',
    url,
    ref: fragment.slice(0, slashIdx),
    subpath: fragment.slice(slashIdx + 1),
  };
}

/**
 * Resolve the directory for an npm-installed skill by walking `node_modules`
 * upward from `cwd` (supports monorepo hoisting). Returns the resolved path
 * or `null` if the package / subpath cannot be found.
 */
export async function resolveNpmSkillDir(
  packageName: string,
  subpath: string,
  cwd: string,
): Promise<string | null> {
  let current = cwd;
  while (true) {
    const candidate = subpath
      ? join(current, 'node_modules', packageName, subpath)
      : join(current, 'node_modules', packageName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Load a skill by its spec string (`code-review`, `npm:@scope/pkg`, `file:./path`, …).
 *
 * Resolution order:
 * 1. `builtin` — package-bundled `skills/<name>/`
 * 2. `npm:`    — `node_modules/<packageName>[/subpath]` walked up from `cwd`
 * 3. `file:`   — direct filesystem path (relative paths resolved from `cwd`)
 *
 * Throws a `ConfigError` if the spec cannot be resolved or the resolved
 * directory does not contain a valid `SKILL.md`.
 */
export async function loadNamedSkill(spec: string, cwd: string): Promise<Skill> {
  const parsed = parseSkillSpec(spec);

  if (parsed.protocol === 'builtin') {
    const skill = await loadBuiltinSkill(parsed.name);
    if (!skill) {
      throw new ConfigError(`Cannot load skill: "${spec}"`, {
        hint: `No built-in skill named "${parsed.name}" was found. Check the skill name, or use npm: / file: to reference external skills.`,
      });
    }
    return skill;
  }

  if (parsed.protocol === 'npm') {
    const dir = await resolveNpmSkillDir(parsed.packageName, parsed.subpath, cwd);
    if (dir === null) {
      const pkgRef = parsed.subpath
        ? `${parsed.packageName} (subpath "${parsed.subpath}")`
        : parsed.packageName;
      throw new ConfigError(`Cannot load skill: "${spec}"`, {
        hint: `Package ${pkgRef} was not found in node_modules. Run \`npm install ${parsed.packageName}\` in the project.`,
      });
    }
    const skill = await loadSkillFromDir(dir, 'npm');
    if (!skill) {
      throw new ConfigError(`Cannot load skill: "${spec}"`, {
        hint: `The package at ${dir} does not contain a valid SKILL.md.`,
      });
    }
    return skill;
  }

  if (parsed.protocol === 'file') {
    const resolvedPath = parsed.path.startsWith('/') ? parsed.path : join(cwd, parsed.path);
    const skill = await loadSkillFromDir(resolvedPath, 'file');
    if (!skill) {
      throw new ConfigError(`Cannot load skill: "${spec}"`, {
        hint: `No valid SKILL.md was found at "${resolvedPath}". Check that the path points to a skill directory.`,
      });
    }
    return skill;
  }

  // git: / git+ssh: — Phase 2 not yet implemented
  throw new ConfigError(`Cannot load skill: "${spec}"`, {
    hint: 'The "git:" and "git+ssh:" protocols are not yet supported. Install the skill as an npm package and reference it with npm: instead.',
  });
}
