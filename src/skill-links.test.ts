import { describe, expect, it } from 'vitest';
import { PRODUCT_URL } from './product.js';
import {
  blobUrl,
  formatSkillLink,
  gitRepoWebUrl,
  skillDisplayName,
  skillSourceUrl,
} from './skill-links.js';

declare const __PKG_VERSION__: string;

describe('blobUrl', () => {
  it('uses the GitHub blob path on github.com', () => {
    expect(blobUrl('https://github.com/org/repo', 'main', 'skills/x/SKILL.md')).toBe(
      'https://github.com/org/repo/blob/main/skills/x/SKILL.md',
    );
  });

  it('uses the GitLab blob path on any other host', () => {
    expect(blobUrl('https://gitlab.example.com/group/sub/repo', 'abc123', 'a/SKILL.md')).toBe(
      'https://gitlab.example.com/group/sub/repo/-/blob/abc123/a/SKILL.md',
    );
  });

  it('falls back to HEAD when no ref is pinned', () => {
    expect(blobUrl('https://gitlab.example.com/g/r', '', 'SKILL.md')).toBe(
      'https://gitlab.example.com/g/r/-/blob/HEAD/SKILL.md',
    );
  });

  it('drops a trailing slash on the repository URL', () => {
    expect(blobUrl('https://github.com/org/repo/', 'main', 'SKILL.md')).toBe(
      'https://github.com/org/repo/blob/main/SKILL.md',
    );
  });

  it('percent-encodes path segments', () => {
    expect(blobUrl('https://github.com/org/repo', 'main', 'my skills/a b/SKILL.md')).toBe(
      'https://github.com/org/repo/blob/main/my%20skills/a%20b/SKILL.md',
    );
  });

  it('returns undefined for a non-URL base', () => {
    expect(blobUrl('not a url', 'main', 'SKILL.md')).toBeUndefined();
  });
});

describe('gitRepoWebUrl', () => {
  it('strips the .git suffix from an https clone URL', () => {
    expect(gitRepoWebUrl('https://gitlab.example.com/tools/kit.git')).toBe(
      'https://gitlab.example.com/tools/kit',
    );
  });

  it('converts an ssh clone URL to https', () => {
    expect(gitRepoWebUrl('ssh://git@gitlab.example.com/tools/kit.git')).toBe(
      'https://gitlab.example.com/tools/kit',
    );
  });

  it('strips the git+ transport marker', () => {
    expect(gitRepoWebUrl('git+ssh://git@gitlab.example.com/tools/kit.git')).toBe(
      'https://gitlab.example.com/tools/kit',
    );
  });

  it('accepts the scp-style form', () => {
    expect(gitRepoWebUrl('git@gitlab.example.com:tools/kit.git')).toBe(
      'https://gitlab.example.com/tools/kit',
    );
  });

  // Credentials embedded in a CI clone URL must never reach a merge-request note.
  it('drops embedded credentials', () => {
    expect(gitRepoWebUrl('https://gitlab-ci-token:s3cret@gitlab.example.com/tools/kit.git')).toBe(
      'https://gitlab.example.com/tools/kit',
    );
  });

  it('returns undefined when there is no repository path', () => {
    expect(gitRepoWebUrl('https://gitlab.example.com')).toBeUndefined();
  });

  it('returns undefined for an unparseable URL', () => {
    expect(gitRepoWebUrl('')).toBeUndefined();
  });
});

describe('skillSourceUrl', () => {
  it('links a built-in skill to the released tag of this package', () => {
    expect(skillSourceUrl({ kind: 'builtin', name: 'code-review' })).toBe(
      `${PRODUCT_URL}/blob/${__PKG_VERSION__}/skills/code-review/SKILL.md`,
    );
  });

  it('links an in-repo skill to the reviewed commit', () => {
    const url = skillSourceUrl(
      { kind: 'project', path: '.claude/skills/house-style' },
      {
        projectWebUrl: 'https://gitlab.example.com/group/app',
        commitSha: 'a35d5b5',
      },
    );
    expect(url).toBe(
      'https://gitlab.example.com/group/app/-/blob/a35d5b5/.claude/skills/house-style/SKILL.md',
    );
  });

  it('leaves an in-repo skill unlinked without CI project coordinates', () => {
    expect(skillSourceUrl({ kind: 'project', path: '.claude/skills/x' })).toBeUndefined();
    expect(
      skillSourceUrl({ kind: 'project', path: '.claude/skills/x' }, { commitSha: 'abc' }),
    ).toBeUndefined();
  });

  it('links an npm skill to its package page', () => {
    expect(skillSourceUrl({ kind: 'npm', packageName: '@scope/pkg', subpath: 'security' })).toBe(
      'https://www.npmjs.com/package/@scope/pkg',
    );
  });

  it('never links a file: skill', () => {
    expect(skillSourceUrl({ kind: 'file', path: '/home/dev/skills/x' })).toBeUndefined();
  });

  it('links a git skill at its pinned ref and subpath', () => {
    expect(
      skillSourceUrl({
        kind: 'git',
        url: 'https://gitlab.example.com/tools/kit.git',
        ref: '1.2.0',
        path: 'skills/security',
      }),
    ).toBe('https://gitlab.example.com/tools/kit/-/blob/1.2.0/skills/security/SKILL.md');
  });

  it('links a git skill that lives at the repository root', () => {
    expect(
      skillSourceUrl({
        kind: 'git',
        url: 'https://gitlab.example.com/tools/kit.git',
        ref: '',
        path: '',
      }),
    ).toBe('https://gitlab.example.com/tools/kit/-/blob/HEAD/SKILL.md');
  });

  it('links a marketplace skill to its path in the marketplace repository', () => {
    expect(
      skillSourceUrl({
        kind: 'marketplace',
        marketplace: 'ikko-tools',
        plugin: 'dev',
        url: 'git+ssh://git@gitlab.studiometa.dev/tools/ikko-tools.git',
        ref: 'main',
        path: 'plugins/dev/skills/aria-apg',
      }),
    ).toBe(
      'https://gitlab.studiometa.dev/tools/ikko-tools/-/blob/main/plugins/dev/skills/aria-apg/SKILL.md',
    );
  });
});

describe('skillDisplayName', () => {
  it('shows a marketplace skill under its full selector', () => {
    expect(
      skillDisplayName({
        name: 'aria-apg',
        origin: {
          kind: 'marketplace',
          marketplace: 'ikko-tools',
          plugin: 'dev',
          url: 'https://gitlab.example.com/tools/ikko-tools.git',
          ref: 'main',
          path: 'plugins/dev/skills/aria-apg',
        },
      }),
    ).toBe('ikko-tools:dev/aria-apg');
  });

  it('shows every other skill under its own name', () => {
    expect(
      skillDisplayName({ name: 'code-review', origin: { kind: 'builtin', name: 'code-review' } }),
    ).toBe('code-review');
  });
});

describe('formatSkillLink', () => {
  it('renders a linked code span when the source is reachable', () => {
    expect(
      formatSkillLink({ name: 'code-review', origin: { kind: 'builtin', name: 'code-review' } }),
    ).toBe(`[\`code-review\`](${PRODUCT_URL}/blob/${__PKG_VERSION__}/skills/code-review/SKILL.md)`);
  });

  it('falls back to a plain code span when there is no source URL', () => {
    expect(formatSkillLink({ name: 'local', origin: { kind: 'file', path: '/tmp/local' } })).toBe(
      '`local`',
    );
  });
});
