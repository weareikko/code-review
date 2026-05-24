import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.js';

export interface Skill {
  name: string;
  description: string;
  /** @deprecated Body is no longer loaded eagerly. Use `filePath` to read the skill content lazily. */
  body?: string;
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

function parseFrontmatter(
  content: string,
): { name: string; description: string; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, body] = match;
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  if (!name || !description) return null;
  return { name, description, body: body.trim() };
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

export async function loadAutoDiscoveredSkills(cwd: string, gitRoot: string): Promise<Skill[]> {
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
        const skill = await loadSkillFromDir(join(skillsPath, entry), 'project');
        if (skill) found.set(skill.name, skill);
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

  // git: and git+ssh: — reserved for Phase 2
  if (spec.startsWith('git:') || spec.startsWith('git+ssh:')) {
    return { protocol: 'git', url: spec, ref: '', subpath: '' };
  }

  // Bare name → builtin
  return { protocol: 'builtin', name: spec };
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
