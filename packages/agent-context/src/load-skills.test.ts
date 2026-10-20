import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSkills } from './load-skills.js';

const cacheDir = join(tmpdir(), 'agent-context-unused-cache');

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

describe('loadSkills', () => {
  it('returns the auto-discovered skills, then the named ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'load-skills-'));
    await writeSkill(join(root, '.claude', 'skills', 'house-style'), 'house-style');
    const builtinSkillsDir = await mkdtemp(join(tmpdir(), 'builtin-'));
    await writeSkill(join(builtinSkillsDir, 'code-review'), 'code-review');

    const skills = await loadSkills(root, root, ['code-review'], { cacheDir, builtinSkillsDir });
    expect(skills.map((s) => [s.name, s.origin.kind])).toEqual([
      ['house-style', 'project'],
      ['code-review', 'builtin'],
    ]);
  });

  it('does not load a named skill again when the repository declares it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'load-skills-'));
    await writeSkill(join(root, '.agents', 'skills', 'code-review'), 'code-review');

    const skills = await loadSkills(root, root, ['code-review'], { cacheDir });
    expect(skills.map((s) => [s.name, s.origin.kind])).toEqual([['code-review', 'project']]);
  });

  it('warns and skips a named skill that fails to load, keeping the others', async () => {
    const root = await mkdtemp(join(tmpdir(), 'load-skills-'));
    await writeSkill(join(root, 'local'), 'local');
    const warnings: string[] = [];

    const skills = await loadSkills(root, root, ['file:/nonexistent/skill/dir', 'file:./local'], {
      cacheDir,
      warn: (msg) => warnings.push(msg),
    });
    expect(skills.map((s) => s.name)).toEqual(['local']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Skipping skill "file:/nonexistent/skill/dir"');
    expect(warnings[0]).toContain('[CONFIG_ERROR]');
  });

  it('resolves a marketplace spec through the registry and names the prefixed variable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'load-skills-'));
    const warnings: string[] = [];

    const skills = await loadSkills(root, root, ['acme:dev/aria-apg'], {
      cacheDir,
      // `acme` is registered, so the spec parses as a marketplace reference;
      // the clone of the unreachable URL fails and the skill is skipped.
      marketplaces: [
        { name: 'acme', format: 'anthropic', url: 'file:///nonexistent/acme.git', ref: '' },
      ],
      envPrefix: 'CODE_REVIEW_',
      warn: (msg) => warnings.push(msg),
    });
    expect(skills).toEqual([]);
    expect(warnings[0]).toContain('Skipping skill "acme:dev/aria-apg"');
    expect(warnings[0]).toContain('Cannot load marketplace "acme"');
  });

  it('skips a spec naming an unregistered marketplace as a bare built-in name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'load-skills-'));
    const warnings: string[] = [];

    const skills = await loadSkills(root, root, ['acme:dev/aria-apg'], {
      cacheDir,
      warn: (msg) => warnings.push(msg),
    });
    expect(skills).toEqual([]);
    expect(warnings[0]).toContain('ships no built-in skills');
  });
});
