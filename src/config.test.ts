import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  resolveConfig,
  validateConfig,
  type Severity,
  type ThinkingLevel,
} from './config.js';

describe('config env defaults', () => {
  it('resolves GitLab CI defaults deterministically', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '123',
      CI_MERGE_REQUEST_IID: '45',
      CI_SERVER_HOST: 'gitlab.example.com',
      GITLAB_TOKEN: 'private-token',
      GITLAB_REVIEW_API_KEY: 'api-key',
    });

    expect(cfg).toMatchObject({
      project: '123',
      mr: '45',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 'private-token',
      gitlabAuthHeader: 'PRIVATE-TOKEN',
      model: 'anthropic/claude-sonnet-4-5',
      minSeverity: 'info',
      thinkingLevel: 'off',
      postingMode: 'direct',
      reviewFile: 'gitlab-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
    });
  });

  it('prefers CLI values over environment defaults', () => {
    const cfg = resolveConfig(
      [
        '--project',
        'cli-project',
        '--mr',
        '9',
        '--gitlab-url',
        'https://cli.example.com/',
        '--gitlab-token',
        'cli-token',
        '--api-key',
        'cli-key',
        '--min-severity',
        'warn',
      ],
      {
        CI_PROJECT_ID: 'env-project',
        CI_MERGE_REQUEST_IID: '8',
        CI_SERVER_URL: 'https://env.example.com',
        GITLAB_TOKEN: 'env-token',
        GITLAB_REVIEW_API_KEY: 'env-key',
      },
    );

    expect(cfg).toMatchObject({
      project: 'cli-project',
      mr: '9',
      gitlabUrl: 'https://cli.example.com',
      gitlabToken: 'cli-token',
      gitlabAuthHeader: 'PRIVATE-TOKEN',
      apiKey: 'cli-key',
      minSeverity: 'warn',
    });
  });

  it('uses CI_JOB_TOKEN with JOB-TOKEN header when no private token is set', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gitlab.example.com',
      CI_JOB_TOKEN: 'job-token',
      GITLAB_REVIEW_API_KEY: 'key',
    });

    expect(cfg).toMatchObject({
      gitlabToken: 'job-token',
      gitlabAuthHeader: 'JOB-TOKEN',
    });
  });
});

describe('validateConfig', () => {
  const minimalConfig: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'tok',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    apiKey: 'key',
    reviewFile: 'gitlab-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: '/tmp',
    skills: [],
  };

  it('throws listing all missing required fields', () => {
    expect(() => validateConfig({ ...minimalConfig, project: '', mr: '' })).toThrow(
      '--project, --mr',
    );
  });

  it('throws on invalid min-severity', () => {
    expect(() => validateConfig({ ...minimalConfig, minSeverity: 'bad' as Severity })).toThrow(
      '--min-severity must be one of',
    );
  });

  it('throws on invalid thinking level', () => {
    expect(() =>
      validateConfig({
        ...minimalConfig,
        thinkingLevel: 'bogus' as ThinkingLevel,
      }),
    ).toThrow('--thinking must be one of: off, minimal, low, medium, high, xhigh');
  });

  it('accepts every documented thinking level', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
      expect(() => validateConfig({ ...minimalConfig, thinkingLevel: level })).not.toThrow();
    }
  });
});

describe('thinking level resolution', () => {
  it('defaults to off when neither flag nor env is set', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_API_KEY: 'k',
    });
    expect(cfg.thinkingLevel).toBe('off');
  });

  it('reads from GITLAB_REVIEW_THINKING_LEVEL env var', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_API_KEY: 'k',
      GITLAB_REVIEW_THINKING_LEVEL: 'medium',
    });
    expect(cfg.thinkingLevel).toBe('medium');
  });

  it('lower-cases and trims env values before validation', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_API_KEY: 'k',
      GITLAB_REVIEW_THINKING_LEVEL: '  HIGH  ',
    });
    expect(cfg.thinkingLevel).toBe('high');
  });

  it('lets --thinking override GITLAB_REVIEW_THINKING_LEVEL', () => {
    const cfg = resolveConfig(['--thinking', 'xhigh'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_API_KEY: 'k',
      GITLAB_REVIEW_THINKING_LEVEL: 'low',
    });
    expect(cfg.thinkingLevel).toBe('xhigh');
  });

  it('rejects invalid values via validateConfig', () => {
    const cfg = resolveConfig(['--thinking', 'sometimes'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_API_KEY: 'k',
    });
    expect(() => validateConfig(cfg)).toThrow('--thinking must be one of');
  });
});

describe('posting mode resolution', () => {
  it('defaults to direct when neither flag nor env is set', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_API_KEY: 'k',
    });
    expect(cfg.postingMode).toBe('direct');
  });

  it('reads from GITLAB_REVIEW_POSTING_MODE env var and trims case', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_API_KEY: 'k',
      GITLAB_REVIEW_POSTING_MODE: '  DRAFT  ',
    });
    expect(cfg.postingMode).toBe('draft');
  });

  it('lets --posting-mode override the env value', () => {
    const cfg = resolveConfig(['--posting-mode', 'direct'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_API_KEY: 'k',
      GITLAB_REVIEW_POSTING_MODE: 'draft',
    });
    expect(cfg.postingMode).toBe('direct');
  });

  it('validateConfig rejects unknown posting modes', () => {
    const cfg = resolveConfig(['--posting-mode', 'bogus'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_API_KEY: 'k',
    });
    expect(() => validateConfig(cfg)).toThrow('--posting-mode must be one of');
  });
});

describe('parseArgs', () => {
  it('parses --key=value inline syntax', () => {
    expect(parseArgs(['--project=123'])).toMatchObject({ project: '123' });
  });

  it('parses -h and -v short flags', () => {
    expect(parseArgs(['-h'])).toMatchObject({ help: true });
    expect(parseArgs(['-v'])).toMatchObject({ version: true });
  });

  it('throws on missing value for non-boolean flag', () => {
    expect(() => parseArgs(['--project'])).toThrow('Missing value for --project');
  });

  it('parses --dry-run and --no-post as booleans', () => {
    expect(parseArgs(['--dry-run', '--no-post'])).toMatchObject({
      dryRun: true,
      noPost: true,
    });
  });
});

describe('dry-run and no-post flags', () => {
  it('resolveConfig sets dryRun from --dry-run', () => {
    const cfg = resolveConfig([
      '--dry-run',
      '--project',
      'p',
      '--mr',
      '1',
      '--gitlab-url',
      'https://gl.example.com',
      '--gitlab-token',
      't',
      '--api-key',
      'k',
    ]);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.noPost).toBe(false);
  });

  it('resolveConfig sets noPost from --no-post', () => {
    const cfg = resolveConfig([
      '--no-post',
      '--project',
      'p',
      '--mr',
      '1',
      '--gitlab-url',
      'https://gl.example.com',
      '--gitlab-token',
      't',
      '--api-key',
      'k',
    ]);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.noPost).toBe(true);
  });
});

describe('summary posting configuration', () => {
  const baseEnv = {
    CI_PROJECT_ID: '1',
    CI_MERGE_REQUEST_IID: '2',
    CI_SERVER_URL: 'https://gl.example.com',
    GITLAB_TOKEN: 't',
    GITLAB_REVIEW_API_KEY: 'k',
  };

  it('defaults postSummary to true', () => {
    expect(resolveConfig([], baseEnv).postSummary).toBe(true);
  });

  it('flips postSummary off via --no-summary', () => {
    expect(resolveConfig(['--no-summary'], baseEnv).postSummary).toBe(false);
  });

  it('flips postSummary off via GITLAB_REVIEW_POST_SUMMARY=false', () => {
    expect(resolveConfig([], { ...baseEnv, GITLAB_REVIEW_POST_SUMMARY: 'false' }).postSummary).toBe(
      false,
    );
  });

  it('--no-summary overrides GITLAB_REVIEW_POST_SUMMARY=true', () => {
    expect(
      resolveConfig(['--no-summary'], { ...baseEnv, GITLAB_REVIEW_POST_SUMMARY: 'true' })
        .postSummary,
    ).toBe(false);
  });

  it('enables forceReview via --force-review', () => {
    expect(resolveConfig(['--force-review'], baseEnv).forceReview).toBe(true);
  });

  it('enables forceReview via GITLAB_REVIEW_FORCE_REVIEW=true', () => {
    expect(resolveConfig([], { ...baseEnv, GITLAB_REVIEW_FORCE_REVIEW: 'true' }).forceReview).toBe(
      true,
    );
  });
});
