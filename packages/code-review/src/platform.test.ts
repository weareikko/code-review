import { describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { ConfigError } from './errors.js';
import { createPlatform } from './platform.js';
import { GitHubPlatform } from './platforms/github.js';
import { GitLabPlatform } from './platforms/gitlab.js';

/**
 * Minimal Config for the factory. The `...overrides` spread relaxes TypeScript's
 * completeness check, so fields the factory never reads can be omitted.
 */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    platform: 'gitlab',
    project: 'group/repo',
    mr: '7',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'secret-token',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    githubRepository: '',
    githubPr: '',
    githubToken: '',
    githubApiUrl: 'https://api.github.com',
    githubServerUrl: 'https://github.com',
    model: 'anthropic/claude-sonnet-4-5',
    ...overrides,
  } as Config;
}

describe('createPlatform', () => {
  it('returns a GitLabPlatform for the gitlab platform', () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(createPlatform(makeConfig({ platform: 'gitlab' }))).toBeInstanceOf(GitLabPlatform);
  });

  it('returns a GitHubPlatform for the github platform', () => {
    vi.stubGlobal('fetch', vi.fn());
    const platform = createPlatform(
      makeConfig({
        platform: 'github',
        githubRepository: 'octo/repo',
        githubPr: '11',
        githubToken: 'gh-token',
      }),
    );
    expect(platform).toBeInstanceOf(GitHubPlatform);
  });

  it('surfaces a ConfigError for a malformed github repository slug', () => {
    expect(() =>
      createPlatform(
        makeConfig({
          platform: 'github',
          githubRepository: 'not-a-slug',
          githubPr: '11',
          githubToken: 'gh-token',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('surfaces a ConfigError for a malformed github pull number', () => {
    expect(() =>
      createPlatform(
        makeConfig({
          platform: 'github',
          githubRepository: 'octo/repo',
          githubPr: 'not-a-number',
          githubToken: 'gh-token',
        }),
      ),
    ).toThrow(ConfigError);
  });
});
