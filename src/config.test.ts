import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGitLabReviewEnvPrefix,
  parseArgs,
  parseModelProvider,
  RESERVED_ENV_SUFFIXES,
  resolveConfig,
  validateConfig,
  type Severity,
  type ThinkingLevel,
} from './config.js';
import { ConfigError } from './errors.js';

describe('config env defaults', () => {
  it('resolves GitLab CI defaults deterministically', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '123',
      CI_MERGE_REQUEST_IID: '45',
      CI_SERVER_HOST: 'gitlab.example.com',
      GITLAB_TOKEN: 'private-token',
      GITLAB_REVIEW_MODEL: 'anthropic/claude-sonnet-4-5',
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
      reviewDepth: 'single',
      reviewFile: 'gitlab-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
      baseUrl: '',
      maxTokens: 0,
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
    });

    expect(cfg).toMatchObject({
      gitlabToken: 'job-token',
      gitlabAuthHeader: 'JOB-TOKEN',
    });
  });

  it('defaults modelPool to an empty list when unset', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gitlab.example.com',
      GITLAB_TOKEN: 'tok',
      GITLAB_REVIEW_MODEL: 'anthropic/claude-sonnet-4-5',
    });
    expect(cfg.modelPool).toEqual([]);
  });

  it('parses GITLAB_REVIEW_MODEL_POOL as a comma-separated, trimmed list', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gitlab.example.com',
      GITLAB_TOKEN: 'tok',
      GITLAB_REVIEW_MODEL: 'anthropic/claude-sonnet-4-5',
      GITLAB_REVIEW_MODEL_POOL: ' anthropic/claude-sonnet-4-5 , google/gemini-2.5-pro ,',
    });
    expect(cfg.modelPool).toEqual(['anthropic/claude-sonnet-4-5', 'google/gemini-2.5-pro']);
  });

  it('prefers --model-pool over GITLAB_REVIEW_MODEL_POOL', () => {
    const cfg = resolveConfig(['--model-pool', 'anthropic/claude-opus-4-1,openai/gpt-5'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gitlab.example.com',
      GITLAB_TOKEN: 'tok',
      GITLAB_REVIEW_MODEL: 'anthropic/claude-sonnet-4-5',
      GITLAB_REVIEW_MODEL_POOL: 'google/gemini-2.5-pro',
    });
    expect(cfg.modelPool).toEqual(['anthropic/claude-opus-4-1', 'openai/gpt-5']);
  });

  const baseEnv = {
    CI_PROJECT_ID: '1',
    CI_MERGE_REQUEST_IID: '2',
    CI_SERVER_URL: 'https://gitlab.example.com',
    GITLAB_TOKEN: 'tok',
    GITLAB_REVIEW_MODEL: 'anthropic/claude-sonnet-4-5',
  };

  it('defaults verifyModel to empty when unset', () => {
    expect(resolveConfig([], { ...baseEnv }).verifyModel).toBe('');
  });

  it('resolves verifyModel from GITLAB_REVIEW_VERIFY_MODEL', () => {
    const cfg = resolveConfig([], {
      ...baseEnv,
      GITLAB_REVIEW_VERIFY_MODEL: 'cloudflare-ai-gateway/gpt-5.4',
    });
    expect(cfg.verifyModel).toBe('cloudflare-ai-gateway/gpt-5.4');
  });

  it('prefers --verify-model over GITLAB_REVIEW_VERIFY_MODEL', () => {
    const cfg = resolveConfig(['--verify-model', 'openai/gpt-5.4'], {
      ...baseEnv,
      GITLAB_REVIEW_VERIFY_MODEL: 'cloudflare-ai-gateway/gpt-5.4',
    });
    expect(cfg.verifyModel).toBe('openai/gpt-5.4');
  });

  it('defaults diffContext to 0 (use built-in default) when unset', () => {
    expect(resolveConfig([], { ...baseEnv }).diffContext).toBe(0);
  });

  it('resolves diffContext from --diff-context and GITLAB_REVIEW_DIFF_CONTEXT', () => {
    expect(resolveConfig(['--diff-context', '8'], { ...baseEnv }).diffContext).toBe(8);
    expect(resolveConfig([], { ...baseEnv, GITLAB_REVIEW_DIFF_CONTEXT: '12' }).diffContext).toBe(
      12,
    );
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
    reviewDepth: 'single',
    apiKey: 'key',
    baseUrl: '',
    maxTokens: 0,
    reviewFile: 'gitlab-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: '/tmp',
    skills: [],
    refreshGitSkills: false,
    modelPool: [],
  } as Config;

  it('throws listing all missing required fields', () => {
    expect(() => validateConfig({ ...minimalConfig, project: '', mr: '' })).toThrow(
      '--project, --mr',
    );
  });

  it('throws when the model is missing', () => {
    let caught: unknown;
    try {
      validateConfig({ ...minimalConfig, model: '' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain('--model');
    expect((caught as ConfigError).hint).toContain('provider/modelId');
  });

  it('throws when the api-key is missing for a non-ollama model', () => {
    expect(() => validateConfig({ ...minimalConfig, apiKey: '' })).toThrow('--api-key');
  });

  it('throws on invalid min-severity', () => {
    expect(() => validateConfig({ ...minimalConfig, minSeverity: 'bad' as Severity })).toThrow(
      '--min-severity must be one of',
    );
  });

  it('emits ambient-credentials hint when api-key is missing for amazon-bedrock', () => {
    let caught: unknown;
    try {
      validateConfig({
        ...minimalConfig,
        model: 'amazon-bedrock/anthropic.claude-3-sonnet',
        apiKey: '',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).hint).toContain('AWS_ACCESS_KEY_ID');
  });

  it('emits ambient-credentials hint when api-key is missing for google-vertex', () => {
    let caught: unknown;
    try {
      validateConfig({ ...minimalConfig, model: 'google-vertex/gemini-1.5-pro', apiKey: '' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).hint).toContain('gcloud auth application-default login');
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
    });
    expect(cfg.thinkingLevel).toBe('off');
  });

  it('reads from GITLAB_REVIEW_THINKING_LEVEL env var', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
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
      GITLAB_REVIEW_THINKING_LEVEL: 'low',
    });
    expect(cfg.thinkingLevel).toBe('xhigh');
  });

  it('rejects invalid values via validateConfig', () => {
    const cfg = resolveConfig(
      ['--thinking', 'sometimes', '--model', 'anthropic/claude-sonnet-4-5', '--api-key', 'k'],
      {
        CI_PROJECT_ID: '1',
        CI_MERGE_REQUEST_IID: '2',
        CI_SERVER_URL: 'https://gl.example.com',
        GITLAB_TOKEN: 't',
      },
    );
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
    });
    expect(cfg.postingMode).toBe('direct');
  });

  it('reads from GITLAB_REVIEW_POSTING_MODE env var and trims case', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
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
      GITLAB_REVIEW_POSTING_MODE: 'draft',
    });
    expect(cfg.postingMode).toBe('direct');
  });

  it('validateConfig rejects unknown posting modes', () => {
    const cfg = resolveConfig(
      ['--posting-mode', 'bogus', '--model', 'anthropic/claude-sonnet-4-5', '--api-key', 'k'],
      {
        CI_PROJECT_ID: '1',
        CI_MERGE_REQUEST_IID: '2',
        CI_SERVER_URL: 'https://gl.example.com',
        GITLAB_TOKEN: 't',
      },
    );
    expect(() => validateConfig(cfg)).toThrow('--posting-mode must be one of');
  });

  it('defaults review depth to single', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
    });
    expect(cfg.reviewDepth).toBe('single');
  });

  it('reads review depth from GITLAB_REVIEW_DEPTH env var and trims case', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_DEPTH: '  VERIFY  ',
    });
    expect(cfg.reviewDepth).toBe('verify');
  });

  it('lets --review-depth override the env value', () => {
    const cfg = resolveConfig(['--review-depth', 'single'], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gl.example.com',
      GITLAB_TOKEN: 't',
      GITLAB_REVIEW_DEPTH: 'verify',
    });
    expect(cfg.reviewDepth).toBe('single');
  });

  it('accepts the full review depth', () => {
    const cfg = resolveConfig(
      ['--review-depth', 'full', '--model', 'anthropic/claude-sonnet-4-5', '--api-key', 'k'],
      {
        CI_PROJECT_ID: '1',
        CI_MERGE_REQUEST_IID: '2',
        CI_SERVER_URL: 'https://gl.example.com',
        GITLAB_TOKEN: 't',
      },
    );
    expect(cfg.reviewDepth).toBe('full');
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('validateConfig rejects unknown review depths', () => {
    const cfg = resolveConfig(
      ['--review-depth', 'bogus', '--model', 'anthropic/claude-sonnet-4-5', '--api-key', 'k'],
      {
        CI_PROJECT_ID: '1',
        CI_MERGE_REQUEST_IID: '2',
        CI_SERVER_URL: 'https://gl.example.com',
        GITLAB_TOKEN: 't',
      },
    );
    expect(() => validateConfig(cfg)).toThrow('--review-depth must be one of');
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

  it('defaults refreshGitSkills to false', () => {
    expect(resolveConfig([], baseEnv).refreshGitSkills).toBe(false);
  });

  it('enables refreshGitSkills via GITLAB_REVIEW_REFRESH_SKILLS=1', () => {
    expect(
      resolveConfig([], { ...baseEnv, GITLAB_REVIEW_REFRESH_SKILLS: '1' }).refreshGitSkills,
    ).toBe(true);
  });

  it('enables refreshGitSkills via GITLAB_REVIEW_REFRESH_SKILLS=true', () => {
    expect(
      resolveConfig([], { ...baseEnv, GITLAB_REVIEW_REFRESH_SKILLS: 'true' }).refreshGitSkills,
    ).toBe(true);
  });
});

describe('parseModelProvider', () => {
  it('extracts the provider from a simple provider/model string', () => {
    expect(parseModelProvider('anthropic/claude-sonnet-4-5')).toBe('anthropic');
  });

  it('extracts the provider from a multi-slash model string', () => {
    expect(parseModelProvider('openrouter/anthropic/claude-3-opus-20240229')).toBe('openrouter');
  });

  it('returns empty string when there is no slash', () => {
    expect(parseModelProvider('just-a-model')).toBe('');
  });

  it('returns the first segment for ollama models', () => {
    expect(parseModelProvider('ollama/qwen2.5-coder:32b')).toBe('ollama');
  });
});

describe('Ollama provider support', () => {
  const baseEnv = {
    CI_PROJECT_ID: '1',
    CI_MERGE_REQUEST_IID: '2',
    CI_SERVER_URL: 'https://gl.example.com',
    GITLAB_TOKEN: 't',
  };

  it('resolves apiKey as "ollama" placeholder when model is ollama and no key is set', () => {
    const cfg = resolveConfig(['--model', 'ollama/qwen2.5-coder:32b'], baseEnv);
    expect(cfg.apiKey).toBe('ollama');
  });

  it('resolves baseUrl from OLLAMA_HOST with /v1 appended', () => {
    const cfg = resolveConfig(['--model', 'ollama/qwen2.5-coder:32b'], {
      ...baseEnv,
      OLLAMA_HOST: 'http://localhost:11434',
    });
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('strips trailing slash from OLLAMA_HOST before appending /v1', () => {
    const cfg = resolveConfig(['--model', 'ollama/llama3:8b'], {
      ...baseEnv,
      OLLAMA_HOST: 'http://ollama.internal/',
    });
    expect(cfg.baseUrl).toBe('http://ollama.internal/v1');
  });

  it('defaults OLLAMA_HOST to http://localhost:11434 when not set', () => {
    const cfg = resolveConfig(['--model', 'ollama/llama3:8b'], baseEnv);
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('--api-key overrides the ollama placeholder', () => {
    const cfg = resolveConfig(
      ['--model', 'ollama/llama3:8b', '--api-key', 'my-actual-key'],
      baseEnv,
    );
    expect(cfg.apiKey).toBe('my-actual-key');
  });

  it('validateConfig does not require api-key for ollama model', () => {
    const cfg = resolveConfig(['--model', 'ollama/llama3:8b'], baseEnv);
    // Empty apiKey should not throw for ollama
    expect(() => validateConfig({ ...cfg, apiKey: '' })).not.toThrow('--api-key');
  });
});

describe('base URL and max tokens overrides', () => {
  const baseEnv = {
    CI_PROJECT_ID: '1',
    CI_MERGE_REQUEST_IID: '2',
    CI_SERVER_URL: 'https://gl.example.com',
    GITLAB_TOKEN: 't',
  };

  it('reads baseUrl from GITLAB_REVIEW_BASE_URL', () => {
    const cfg = resolveConfig([], {
      ...baseEnv,
      GITLAB_REVIEW_BASE_URL: 'https://my-proxy.example.com/v1',
    });
    expect(cfg.baseUrl).toBe('https://my-proxy.example.com/v1');
  });

  it('reads baseUrl from --base-url flag', () => {
    const cfg = resolveConfig(['--base-url', 'https://custom.example.com/v1'], baseEnv);
    expect(cfg.baseUrl).toBe('https://custom.example.com/v1');
  });

  it('--base-url flag overrides GITLAB_REVIEW_BASE_URL', () => {
    const cfg = resolveConfig(['--base-url', 'https://flag.example.com/v1'], {
      ...baseEnv,
      GITLAB_REVIEW_BASE_URL: 'https://env.example.com/v1',
    });
    expect(cfg.baseUrl).toBe('https://flag.example.com/v1');
  });

  it('reads maxTokens from GITLAB_REVIEW_MAX_TOKENS', () => {
    const cfg = resolveConfig([], { ...baseEnv, GITLAB_REVIEW_MAX_TOKENS: '8192' });
    expect(cfg.maxTokens).toBe(8192);
  });

  it('reads maxTokens from --max-tokens flag', () => {
    const cfg = resolveConfig(['--max-tokens', '4096'], baseEnv);
    expect(cfg.maxTokens).toBe(4096);
  });

  it('defaults maxTokens to 0 when not set', () => {
    const cfg = resolveConfig([], baseEnv);
    expect(cfg.maxTokens).toBe(0);
  });

  it('reads maxDiffChars from GITLAB_REVIEW_MAX_DIFF_CHARS', () => {
    const cfg = resolveConfig([], { ...baseEnv, GITLAB_REVIEW_MAX_DIFF_CHARS: '50000' });
    expect(cfg.maxDiffChars).toBe(50000);
  });

  it('reads maxDiffChars from --max-diff-chars flag', () => {
    const cfg = resolveConfig(['--max-diff-chars', '250000'], baseEnv);
    expect(cfg.maxDiffChars).toBe(250000);
  });

  it('--max-diff-chars flag overrides GITLAB_REVIEW_MAX_DIFF_CHARS', () => {
    const cfg = resolveConfig(['--max-diff-chars', '250000'], {
      ...baseEnv,
      GITLAB_REVIEW_MAX_DIFF_CHARS: '50000',
    });
    expect(cfg.maxDiffChars).toBe(250000);
  });

  it('defaults maxDiffChars to 100_000 when not set', () => {
    const cfg = resolveConfig([], baseEnv);
    expect(cfg.maxDiffChars).toBe(100_000);
  });

  it('falls back to the 100_000 default when maxDiffChars is non-positive or invalid', () => {
    expect(resolveConfig([], { ...baseEnv, GITLAB_REVIEW_MAX_DIFF_CHARS: '0' }).maxDiffChars).toBe(
      100_000,
    );
    expect(
      resolveConfig([], { ...baseEnv, GITLAB_REVIEW_MAX_DIFF_CHARS: 'nonsense' }).maxDiffChars,
    ).toBe(100_000);
  });

  it('reads decomposeHintLines from GITLAB_REVIEW_DECOMPOSE_HINT_LINES', () => {
    const cfg = resolveConfig([], { ...baseEnv, GITLAB_REVIEW_DECOMPOSE_HINT_LINES: '1500' });
    expect(cfg.decomposeHintLines).toBe(1500);
  });

  it('reads decomposeHintLines from --decompose-hint-lines flag', () => {
    const cfg = resolveConfig(['--decompose-hint-lines', '800'], baseEnv);
    expect(cfg.decomposeHintLines).toBe(800);
  });

  it('--decompose-hint-lines flag overrides GITLAB_REVIEW_DECOMPOSE_HINT_LINES', () => {
    const cfg = resolveConfig(['--decompose-hint-lines', '800'], {
      ...baseEnv,
      GITLAB_REVIEW_DECOMPOSE_HINT_LINES: '1500',
    });
    expect(cfg.decomposeHintLines).toBe(800);
  });

  it('defaults decomposeHintLines to 0 (off) when not set', () => {
    const cfg = resolveConfig([], baseEnv);
    expect(cfg.decomposeHintLines).toBe(0);
  });

  it('clamps an invalid decomposeHintLines to 0 (off)', () => {
    expect(
      resolveConfig([], { ...baseEnv, GITLAB_REVIEW_DECOMPOSE_HINT_LINES: 'nonsense' })
        .decomposeHintLines,
    ).toBe(0);
  });

  it('GITLAB_REVIEW_BASE_URL takes priority over OLLAMA_HOST', () => {
    const cfg = resolveConfig(['--model', 'ollama/llama3:8b'], {
      ...baseEnv,
      OLLAMA_HOST: 'http://localhost:11434',
      GITLAB_REVIEW_BASE_URL: 'http://override.example.com/v1',
    });
    expect(cfg.baseUrl).toBe('http://override.example.com/v1');
  });
});

describe('multi-slash model IDs', () => {
  const baseEnv = {
    CI_PROJECT_ID: '1',
    CI_MERGE_REQUEST_IID: '2',
    CI_SERVER_URL: 'https://gl.example.com',
    GITLAB_TOKEN: 't',
  };

  it('preserves multi-slash model IDs like openrouter/anthropic/claude-3-opus', () => {
    const cfg = resolveConfig(['--model', 'openrouter/anthropic/claude-3-opus-20240229'], baseEnv);
    expect(cfg.model).toBe('openrouter/anthropic/claude-3-opus-20240229');
  });

  it('resolves GITLAB_REVIEW_MODEL with multi-slash ID', () => {
    const cfg = resolveConfig([], {
      ...baseEnv,
      GITLAB_REVIEW_MODEL: 'openrouter/meta-llama/llama-3-8b-instruct',
    });
    expect(cfg.model).toBe('openrouter/meta-llama/llama-3-8b-instruct');
  });
});

describe('provider-aware key resolution', () => {
  const gitlab = {
    CI_PROJECT_ID: '1',
    CI_MERGE_REQUEST_IID: '2',
    CI_SERVER_URL: 'https://gl.example.com',
    GITLAB_TOKEN: 't',
  };

  // The API key is resolved from the provider's standard env var via pi-ai's
  // `getEnvApiKey`, which reads the real `process.env` (not the injected env).
  // Clear the provider key vars before each test and set the ones under test
  // with `vi.stubEnv`, so resolution is deterministic regardless of the
  // runner's environment (e.g. a developer who exported keys from `.env`).
  const PROVIDER_KEY_ENV_VARS = [
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_CLOUD_API_KEY',
    'GROQ_API_KEY',
    'XAI_API_KEY',
    'MISTRAL_API_KEY',
    'DEEPSEEK_API_KEY',
    'GITLAB_REVIEW_API_KEY',
    'CLAUDE_API_KEY',
  ];

  beforeEach(() => {
    for (const key of PROVIDER_KEY_ENV_VARS) vi.stubEnv(key, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets --api-key win over the provider env key', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-anthropic');
    const cfg = resolveConfig(
      ['--model', 'anthropic/claude-sonnet-4-5', '--api-key', 'cli'],
      gitlab,
    );
    expect(cfg.apiKey).toBe('cli');
  });

  it("resolves the key from the provider's standard env var via pi-ai", () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    const cfg = resolveConfig(['--model', 'anthropic/claude-sonnet-4-5'], gitlab);
    expect(cfg.apiKey).toBe('anthropic-key');
  });

  it('resolves OPENAI_API_KEY for an openai model', () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-key');
    const cfg = resolveConfig(['--model', 'openai/gpt-5.4'], gitlab);
    expect(cfg.apiKey).toBe('openai-key');
  });

  it('prefers ANTHROPIC_OAUTH_TOKEN over ANTHROPIC_API_KEY', () => {
    vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', 'oauth-token');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    const cfg = resolveConfig(['--model', 'anthropic/claude-sonnet-4-5'], gitlab);
    expect(cfg.apiKey).toBe('oauth-token');
  });

  it('never sends a key across providers: an openai model with only an anthropic key fails fast', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    const cfg = resolveConfig(['--model', 'openai/gpt-5.4'], gitlab);
    expect(cfg.apiKey).toBe('');
    expect(() => validateConfig(cfg)).toThrow('--api-key');
  });

  it('requires an explicit model: an unset model fails fast', () => {
    const cfg = resolveConfig([], gitlab);
    expect(cfg.model).toBe('');
    expect(() => validateConfig(cfg)).toThrow('--model');
  });

  it('does not treat GITLAB_REVIEW_API_KEY as a provider key', () => {
    vi.stubEnv('GITLAB_REVIEW_API_KEY', 'legacy-key');
    const cfg = resolveConfig(['--model', 'anthropic/claude-sonnet-4-5'], gitlab);
    expect(cfg.apiKey).toBe('');
    expect(() => validateConfig(cfg)).toThrow('--api-key');
  });

  it('does not treat CLAUDE_API_KEY as a provider key', () => {
    vi.stubEnv('CLAUDE_API_KEY', 'legacy-claude-key');
    const cfg = resolveConfig(['--model', 'anthropic/claude-sonnet-4-5'], gitlab);
    expect(cfg.apiKey).toBe('');
    expect(() => validateConfig(cfg)).toThrow('--api-key');
  });

  it('uses the ollama placeholder without a key and does not require api-key', () => {
    const cfg = resolveConfig(['--model', 'ollama/llama3:8b'], gitlab);
    expect(cfg.apiKey).toBe('ollama');
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('applyGitLabReviewEnvPrefix', () => {
  it('exposes GITLAB_REVIEW_<NAME> as <NAME> for non-reserved names', () => {
    const env: NodeJS.ProcessEnv = {
      GITLAB_REVIEW_CLOUDFLARE_API_KEY: 'cf-key',
      GITLAB_REVIEW_CLOUDFLARE_ACCOUNT_ID: 'acct',
      GITLAB_REVIEW_GITLAB_TOKEN: 'tok',
    };
    applyGitLabReviewEnvPrefix(env);
    expect(env.CLOUDFLARE_API_KEY).toBe('cf-key');
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct');
    expect(env.GITLAB_TOKEN).toBe('tok');
  });

  it('lets the prefixed value win over a plain value of the same name', () => {
    const env: NodeJS.ProcessEnv = {
      CLOUDFLARE_API_KEY: 'project-wide',
      GITLAB_REVIEW_CLOUDFLARE_API_KEY: 'scoped',
    };
    applyGitLabReviewEnvPrefix(env);
    expect(env.CLOUDFLARE_API_KEY).toBe('scoped');
  });

  it('fills in a gap when only the prefixed value is set', () => {
    const env: NodeJS.ProcessEnv = {
      GITLAB_REVIEW_ANTHROPIC_API_KEY: 'sk-test',
    };
    applyGitLabReviewEnvPrefix(env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('never de-prefixes the tool’s own reserved settings', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const suffix of RESERVED_ENV_SUFFIXES) {
      env[`GITLAB_REVIEW_${suffix}`] = `reserved-${suffix}`;
    }
    applyGitLabReviewEnvPrefix(env);
    for (const suffix of RESERVED_ENV_SUFFIXES) {
      expect(env[suffix]).toBeUndefined();
      expect(env[`GITLAB_REVIEW_${suffix}`]).toBe(`reserved-${suffix}`);
    }
  });

  it('never revives GITLAB_REVIEW_API_KEY as a provider key', () => {
    const env: NodeJS.ProcessEnv = {
      GITLAB_REVIEW_API_KEY: 'legacy-key',
    };
    applyGitLabReviewEnvPrefix(env);
    expect(env.API_KEY).toBeUndefined();
  });

  it('never lets a double-prefixed name clobber a reserved setting', () => {
    const env: NodeJS.ProcessEnv = {
      GITLAB_REVIEW_MODEL: 'reserved-model',
      GITLAB_REVIEW_GITLAB_REVIEW_MODEL: 'attacker-model',
    };
    applyGitLabReviewEnvPrefix(env);
    expect(env.GITLAB_REVIEW_MODEL).toBe('reserved-model');
    expect(env.GITLAB_REVIEW_GITLAB_REVIEW_MODEL).toBe('attacker-model');
  });

  it('is a no-op when no GITLAB_REVIEW_ vars are set', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'existing',
      GITLAB_TOKEN: 'tok',
    };
    const before = { ...env };
    applyGitLabReviewEnvPrefix(env);
    expect(env).toEqual(before);
  });

  it('does not introduce a key for an empty prefixed value', () => {
    const env: NodeJS.ProcessEnv = {
      GITLAB_REVIEW_OLLAMA_HOST: '',
    };
    applyGitLabReviewEnvPrefix(env);
    expect('OLLAMA_HOST' in env).toBe(false);
  });

  it('returns the same env object it was given', () => {
    const env: NodeJS.ProcessEnv = { GITLAB_REVIEW_FOO: 'bar' };
    expect(applyGitLabReviewEnvPrefix(env)).toBe(env);
  });

  it('reserves exactly the documented suffixes', () => {
    expect([...RESERVED_ENV_SUFFIXES].toSorted()).toEqual(
      [
        'API_KEY',
        'BASE_URL',
        'DECOMPOSE_HINT_LINES',
        'FORCE_REVIEW',
        'MAX_DIFF_CHARS',
        'MAX_TOKENS',
        'MIN_SEVERITY',
        'MODEL',
        'MODEL_POOL',
        'OTEL',
        'OTEL_CAPTURE_CONTENT',
        'POSTING_MODE',
        'POST_SUMMARY',
        'REFRESH_SKILLS',
        'SKILLS',
        'THINKING_LEVEL',
        'VERBOSE',
      ].toSorted(),
    );
  });
});
