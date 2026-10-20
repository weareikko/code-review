import { describe, expect, it } from 'vitest';
import { formatMcpFooter, formatSkillsFooter, type McpServerUsage } from './footer.js';

const builtinSkills = {
  repoWebUrl: 'https://github.com/weareikko/code-review',
  ref: '0.10.3',
};

describe('formatSkillsFooter', () => {
  it('returns undefined when no skill was loaded', () => {
    expect(formatSkillsFooter([])).toBeUndefined();
  });

  it('links each skill to its source and names marketplace skills in full', () => {
    const footer = formatSkillsFooter(
      [
        { name: 'code-review', reads: 2, origin: { kind: 'builtin', name: 'code-review' } },
        {
          name: 'house-style',
          reads: 0,
          origin: { kind: 'project', path: '.claude/skills/house-style' },
        },
        {
          name: 'aria-apg',
          reads: 1,
          origin: {
            kind: 'marketplace',
            marketplace: 'ikko-tools',
            plugin: 'dev',
            url: 'git+ssh://git@gitlab.example.com/tools/ikko-tools.git',
            ref: 'main',
            path: 'plugins/dev/skills/aria-apg',
          },
        },
      ],
      { projectWebUrl: 'https://gitlab.example.com/group/app', commitSha: 'abc123', builtinSkills },
    );
    expect(footer).toBe(
      'Skills: ' +
        '[`code-review`](https://github.com/weareikko/code-review/blob/0.10.3/skills/code-review/SKILL.md) (read), ' +
        '[`house-style`](https://gitlab.example.com/group/app/-/blob/abc123/.claude/skills/house-style/SKILL.md) (not read), ' +
        '[`ikko-tools:dev/aria-apg`](https://gitlab.example.com/tools/ikko-tools/-/blob/main/plugins/dev/skills/aria-apg/SKILL.md) (read)',
    );
  });

  it('falls back to plain names when a source cannot be linked', () => {
    expect(
      formatSkillsFooter([
        { name: 'local', reads: 3, origin: { kind: 'file', path: '/tmp/local' } },
      ]),
    ).toBe('Skills: `local` (read)');
  });
});

describe('formatMcpFooter', () => {
  it('returns undefined when no MCP server was configured', () => {
    expect(formatMcpFooter([])).toBeUndefined();
  });

  it('counts the calls of a connected server and flags an unavailable one', () => {
    const servers: McpServerUsage[] = [
      {
        name: 'jira',
        status: 'connected',
        calls: 2,
        source: { kind: 'file', path: 'mcp-extra.json' },
      },
      {
        name: 'docs',
        status: 'unavailable',
        calls: 0,
        source: { kind: 'file', path: 'mcp-extra.json' },
      },
    ];
    expect(formatMcpFooter(servers)).toBe('MCP: jira (2 calls), docs (unavailable)');
  });

  it('reports a connected server that was never called as unused, not unavailable', () => {
    const servers: McpServerUsage[] = [
      {
        name: 'empty',
        status: 'connected',
        calls: 0,
        source: { kind: 'file', path: 'mcp-extra.json' },
      },
      {
        name: 'once',
        status: 'connected',
        calls: 1,
        source: { kind: 'file', path: 'mcp-extra.json' },
      },
    ];
    expect(formatMcpFooter(servers)).toBe('MCP: empty (unused), once (1 call)');
  });

  it('links a server to its repo .mcp.json when project coordinates are available', () => {
    const servers: McpServerUsage[] = [
      {
        name: 'jira',
        status: 'connected',
        calls: 3,
        source: { kind: 'project', path: '.mcp.json' },
      },
    ];
    const footer = formatMcpFooter(servers, {
      projectWebUrl: 'https://gitlab.example.com/group/app',
      commitSha: 'abc123',
    });
    expect(footer).toBe(
      'MCP: [jira](https://gitlab.example.com/group/app/-/blob/abc123/.mcp.json) (3 calls)',
    );
  });

  it('links a marketplace server to the plugin directory in the marketplace repo', () => {
    const servers: McpServerUsage[] = [
      {
        name: 'context7',
        status: 'connected',
        calls: 0,
        source: {
          kind: 'marketplace',
          marketplace: 'ikko-tools',
          plugin: 'dev',
          url: 'git+ssh://git@gitlab.example.com/tools/ikko-tools.git',
          ref: 'main',
          path: 'plugins/dev',
        },
      },
    ];
    expect(formatMcpFooter(servers)).toBe(
      'MCP: [context7](https://gitlab.example.com/tools/ikko-tools/-/tree/main/plugins/dev) (unused)',
    );
  });

  it('falls back to a plain name when a source cannot be linked (a file: spec, or no project coordinates)', () => {
    const servers: McpServerUsage[] = [
      {
        name: 'local',
        status: 'connected',
        calls: 1,
        source: { kind: 'file', path: '/tmp/mcp-extra.json' },
      },
      {
        name: 'inrepo',
        status: 'connected',
        calls: 2,
        source: { kind: 'project', path: '.mcp.json' },
      },
    ];
    expect(formatMcpFooter(servers)).toBe('MCP: local (1 call), inrepo (2 calls)');
  });
});
