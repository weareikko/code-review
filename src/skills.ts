import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Skill {
  name: string;
  description: string;
  body: string;
  rootDir: string;
  resourceDirs: string[];
  source: 'builtin' | 'project';
}

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
  source: 'builtin' | 'project',
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
    body: parsed.body,
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
