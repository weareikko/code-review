import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSkillReadCounter,
  findSkillForPath,
  formatMcpUsageState,
  formatReviewUsageSummary,
  formatSkillUsageState,
  readToolPath,
} from './skill-usage.js';

const skills = [
  { name: 'code-review', rootDir: '/skills/code-review' },
  { name: 'test-integrity', rootDir: '/skills/test-integrity' },
];

describe('readToolPath', () => {
  it('returns the file path of a built-in read call', () => {
    expect(readToolPath('Read', { file_path: '/skills/code-review/SKILL.md' })).toBe(
      '/skills/code-review/SKILL.md',
    );
    expect(readToolPath('read', { file_path: 'a.ts' })).toBe('a.ts');
  });

  it('ignores every other tool and any call with no usable path', () => {
    expect(readToolPath('Bash', { command: 'cat /skills/code-review/SKILL.md' })).toBeUndefined();
    expect(
      readToolPath('mcp__docs__read_doc', { file_path: '/skills/x/SKILL.md' }),
    ).toBeUndefined();
    expect(readToolPath('Read', { pattern: '**/*' })).toBeUndefined();
    expect(readToolPath('Read', { file_path: '' })).toBeUndefined();
    expect(readToolPath('Read', undefined)).toBeUndefined();
  });
});

describe('findSkillForPath', () => {
  it('matches the SKILL.md itself', () => {
    expect(findSkillForPath(skills, '/skills/code-review/SKILL.md')?.name).toBe('code-review');
  });

  it('matches any file under the skill directory, references included', () => {
    expect(findSkillForPath(skills, '/skills/code-review/references/javascript.md')?.name).toBe(
      'code-review',
    );
  });

  it('resolves a relative path against the working directory', () => {
    const local = [{ name: 'local', rootDir: resolve('skills/local') }];
    expect(findSkillForPath(local, join('skills', 'local', 'SKILL.md'))?.name).toBe('local');
  });

  it('does not match a sibling directory that shares a prefix', () => {
    expect(findSkillForPath(skills, '/skills/code-review-extra/SKILL.md')).toBeUndefined();
  });

  it('returns undefined for a read outside every skill', () => {
    expect(findSkillForPath(skills, '/repo/src/auth.ts')).toBeUndefined();
    expect(findSkillForPath([], '/skills/code-review/SKILL.md')).toBeUndefined();
  });
});

describe('createSkillReadCounter', () => {
  it('counts reads per skill and ignores everything else', () => {
    const counter = createSkillReadCounter(skills);
    counter.record('Read', { file_path: '/skills/code-review/SKILL.md' });
    counter.record('Read', { file_path: '/skills/code-review/references/php.md' });
    counter.record('Read', { file_path: '/repo/src/auth.ts' });
    counter.record('Bash', { command: 'cat /skills/test-integrity/SKILL.md' });

    expect(counter.countFor(skills[0])).toBe(2);
    expect(counter.countFor(skills[1])).toBe(0);
  });

  it('keeps two skills with the same name apart by directory', () => {
    const sameName = [
      { name: 'house-style', rootDir: '/a/house-style' },
      { name: 'house-style', rootDir: '/b/house-style' },
    ];
    const counter = createSkillReadCounter(sameName);
    counter.record('Read', { file_path: '/b/house-style/SKILL.md' });

    expect(counter.countFor(sameName[0])).toBe(0);
    expect(counter.countFor(sameName[1])).toBe(1);
  });
});

describe('formatSkillUsageState', () => {
  it('reports read or not read rather than a count', () => {
    expect(formatSkillUsageState({ reads: 0 })).toBe('not read');
    expect(formatSkillUsageState({ reads: 1 })).toBe('read');
    expect(formatSkillUsageState({ reads: 4 })).toBe('read');
  });
});

describe('formatMcpUsageState', () => {
  it('pluralises the call count', () => {
    expect(formatMcpUsageState({ status: 'connected', calls: 1 })).toBe('1 call');
    expect(formatMcpUsageState({ status: 'connected', calls: 2 })).toBe('2 calls');
  });

  it('distinguishes a connected-but-never-called server from an unavailable one', () => {
    expect(formatMcpUsageState({ status: 'connected', calls: 0 })).toBe('unused');
    expect(formatMcpUsageState({ status: 'unavailable', calls: 0 })).toBe('unavailable');
  });
});

describe('formatReviewUsageSummary', () => {
  it('renders both halves', () => {
    expect(
      formatReviewUsageSummary({
        skills: [
          { name: 'code-review', reads: 2 },
          { name: 'test-integrity', reads: 0 },
        ],
        mcp: [
          { name: 'github', status: 'connected', calls: 1 },
          { name: 'docs', status: 'connected', calls: 2 },
          { name: 'context7', status: 'connected', calls: 0 },
          { name: 'jira', status: 'unavailable', calls: 0 },
        ],
      }),
    ).toBe(
      'Usage: skills code-review (read), test-integrity (not read); ' +
        'MCP github (1 call), docs (2 calls), context7 (unused), jira (unavailable)',
    );
  });

  it('omits the MCP half when no server is configured', () => {
    expect(formatReviewUsageSummary({ skills: [{ name: 'code-review', reads: 1 }], mcp: [] })).toBe(
      'Usage: skills code-review (read)',
    );
  });

  it('omits the skills half when no skill is loaded', () => {
    expect(
      formatReviewUsageSummary({
        skills: [],
        mcp: [{ name: 'docs', status: 'connected', calls: 3 }],
      }),
    ).toBe('Usage: MCP docs (3 calls)');
  });

  it('returns undefined when neither was configured', () => {
    expect(formatReviewUsageSummary({ skills: [], mcp: [] })).toBeUndefined();
  });
});
