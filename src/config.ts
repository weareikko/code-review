import { getEnvApiKey } from '@earendil-works/pi-ai';
import { ConfigError } from './errors.js';
import { POSTING_MODES, type PostingMode } from './posting.js';
import { splitModel, THINKING_LEVELS, type Severity, type ThinkingLevel } from './types.js';

export type GitLabAuthHeader = 'PRIVATE-TOKEN' | 'JOB-TOKEN';

export interface Config {
  project: string;
  mr: string;
  gitlabUrl: string;
  gitlabToken: string;
  gitlabAuthHeader: GitLabAuthHeader;
  model: string;
  minSeverity: Severity;
  thinkingLevel: ThinkingLevel;
  postingMode: PostingMode;
  apiKey: string;
  /** Custom base URL for the AI provider API (e.g. Ollama or other OpenAI-compatible endpoints). */
  baseUrl: string;
  /** Maximum output tokens to request from the model. 0 uses the model's default. */
  maxTokens: number;
  reviewFile: string;
  output: string;
  dryRun: boolean;
  noPost: boolean;
  postSummary: boolean;
  forceReview: boolean;
  verbose: boolean;
  cwd: string;
  skills: string[];
  /** Re-clone `git:` / `git+ssh:` skills, bypassing the on-disk clone cache. */
  refreshGitSkills: boolean;
}

export type ParsedArgs = Record<string, string | boolean | string[]>;

const BOOLEAN_FLAGS = new Set([
  'dry-run',
  'no-post',
  'no-summary',
  'force-review',
  'verbose',
  'help',
  'version',
]);

const MULTI_FLAGS = new Set(['skill']);

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '-v') {
      args.version = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;

    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    if (!rawKey) continue;
    const key = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

    let value: string | boolean;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (BOOLEAN_FLAGS.has(rawKey)) {
      value = true;
    } else {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new ConfigError(`Missing value for --${rawKey}`, {
          hint: `Pass a value after --${rawKey} or use --${rawKey}=<value>.`,
        });
      }
      value = next;
      i += 1;
    }

    if (MULTI_FLAGS.has(rawKey)) {
      const existing = args[key];
      args[key] = Array.isArray(existing) ? [...existing, value as string] : [value as string];
    } else {
      args[key] = value;
    }
  }

  return args;
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

function resolvePostSummary(args: ParsedArgs, env: NodeJS.ProcessEnv): boolean {
  if (args.noSummary === true) return false;
  const raw = env.GITLAB_REVIEW_POST_SUMMARY;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    if (normalized.length > 0) return true;
  }
  return true;
}

function normalizeChoice(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Extract the provider name from a `"provider/modelId"` model string.
 * Returns an empty string when the model string contains no slash.
 */
export function parseModelProvider(model: string): string {
  return splitModel(model).provider ?? '';
}

/**
 * Resolve the base URL for the Ollama provider from the `OLLAMA_HOST` env var.
 * Returns `undefined` for non-Ollama models.
 *
 * The Ollama OpenAI-compatible endpoint lives at `<host>/v1`.
 */
function resolveOllamaBaseUrl(model: string, env: NodeJS.ProcessEnv): string | undefined {
  if (parseModelProvider(model) !== 'ollama') return undefined;
  const host = env.OLLAMA_HOST ?? 'http://localhost:11434';
  return `${host.replace(/\/$/, '')}/v1`;
}

/**
 * Resolve the API key for the given model's provider, delegating entirely to
 * `@earendil-works/pi-ai`'s `getEnvApiKey`. That helper reads the provider's
 * standard environment variable (e.g. `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN`,
 * `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, …) and resolves
 * ambient credentials (Amazon Bedrock, Google Vertex ADC). The key is therefore
 * always provider-specific — a key for provider X is never used for provider Y.
 *
 * Ollama is a local OpenAI-compatible endpoint that needs no key, so a
 * placeholder is returned. The `--api-key` flag takes precedence in
 * `resolveConfig`.
 *
 * NOTE: `getEnvApiKey` reads `process.env` directly (not a passed-in env), so
 * tests stub `process.env` or pass `--api-key` to control the resolved key.
 */
function resolveProviderApiKey(model: string): string {
  const provider = parseModelProvider(model);
  if (!provider) return '';
  // Ollama is a local endpoint — no real key needed.
  if (provider === 'ollama') return 'ollama';
  return getEnvApiKey(provider) ?? '';
}

function resolveSkills(args: ParsedArgs, env: NodeJS.ProcessEnv): string[] {
  const argSkill = args.skill;
  if (Array.isArray(argSkill) && argSkill.length > 0) return argSkill;
  if (typeof argSkill === 'string' && argSkill.length > 0) return [argSkill];
  const envVal = env.GITLAB_REVIEW_SKILLS;
  if (envVal)
    return envVal
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function resolveGitLabToken(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): { token: string; header: GitLabAuthHeader } {
  if (typeof args.gitlabToken === 'string' && args.gitlabToken.length > 0) {
    return { token: args.gitlabToken, header: 'PRIVATE-TOKEN' };
  }

  if (env.GITLAB_TOKEN) return { token: env.GITLAB_TOKEN, header: 'PRIVATE-TOKEN' };
  if (env.GLAB_CLI_TOKEN) return { token: env.GLAB_CLI_TOKEN, header: 'PRIVATE-TOKEN' };
  if (env.CI_JOB_TOKEN) return { token: env.CI_JOB_TOKEN, header: 'JOB-TOKEN' };
  if (env.GITLAB_PRIVATE_TOKEN) return { token: env.GITLAB_PRIVATE_TOKEN, header: 'PRIVATE-TOKEN' };

  return { token: '', header: 'PRIVATE-TOKEN' };
}

export function resolveConfig(argv = process.argv.slice(2), env = process.env): Config {
  const args = parseArgs(argv);
  const gitlabUrl = String(
    args.gitlabUrl ??
      first(env.CI_SERVER_URL, env.CI_SERVER_HOST ? `https://${env.CI_SERVER_HOST}` : undefined) ??
      '',
  ).replace(/\/$/, '');
  const token = resolveGitLabToken(args, env);

  // Model and API key are both required — there is no implicit default model.
  // The model is `provider/modelId`; supply it via --model or GITLAB_REVIEW_MODEL.
  const model = String(args.model ?? env.GITLAB_REVIEW_MODEL ?? '');

  // API key resolution:
  //   1. --api-key flag (explicit override)
  //   2. The model provider's standard env var / ambient credentials, via
  //      pi-ai's getEnvApiKey — resolved provider-specifically so a key for one
  //      provider is never sent to another. Ollama uses a placeholder.
  const apiKey = String(args.apiKey ?? resolveProviderApiKey(model) ?? '');

  // Base URL resolution priority:
  //   1. --base-url flag
  //   2. GITLAB_REVIEW_BASE_URL (universal override for any OpenAI-compatible endpoint)
  //   3. OLLAMA_HOST (automatic for ollama provider)
  const baseUrl = String(
    args.baseUrl ?? first(env.GITLAB_REVIEW_BASE_URL, resolveOllamaBaseUrl(model, env)) ?? '',
  );

  const maxTokens = Number(args.maxTokens ?? env.GITLAB_REVIEW_MAX_TOKENS ?? 0);

  return {
    project: String(args.project ?? env.CI_PROJECT_ID ?? ''),
    mr: String(args.mr ?? env.CI_MERGE_REQUEST_IID ?? ''),
    gitlabUrl,
    gitlabToken: token.token,
    gitlabAuthHeader: token.header,
    model,
    minSeverity: normalizeChoice(
      args.minSeverity ?? env.GITLAB_REVIEW_MIN_SEVERITY ?? 'info',
    ) as Severity,
    thinkingLevel: normalizeChoice(
      args.thinking ?? env.GITLAB_REVIEW_THINKING_LEVEL ?? 'off',
    ) as ThinkingLevel,
    postingMode: normalizeChoice(
      args.postingMode ?? env.GITLAB_REVIEW_POSTING_MODE ?? 'direct',
    ) as PostingMode,
    apiKey,
    baseUrl,
    maxTokens,
    reviewFile: String(args.reviewFile ?? 'gitlab-review.md'),
    output: String(args.output ?? 'review-comments.json'),
    dryRun: toBoolean(args.dryRun),
    noPost: toBoolean(args.noPost),
    postSummary: resolvePostSummary(args, env),
    forceReview: toBoolean(args.forceReview) || toBoolean(env.GITLAB_REVIEW_FORCE_REVIEW),
    verbose: toBoolean(args.verbose) || toBoolean(env.GITLAB_REVIEW_VERBOSE),
    cwd: String(args.cwd ?? process.cwd()),
    skills: resolveSkills(args, env),
    refreshGitSkills: toBoolean(env.GITLAB_REVIEW_REFRESH_SKILLS),
  };
}

export function validateConfig(config: Config): void {
  // `api-key` is optional for providers that supply ambient credentials (e.g.
  // AWS Bedrock, Google Vertex) or that don't need a key at all (Ollama).
  // `resolveConfig` populates `apiKey` with a placeholder for these cases, so
  // the falsy check below already skips them — but we also skip when the
  // provider is `ollama` even if someone passes an empty string explicitly.
  const provider = parseModelProvider(config.model);
  const requiresApiKey = provider !== 'ollama';

  const missing = [
    ['project', config.project],
    ['mr', config.mr],
    ['gitlab-url', config.gitlabUrl],
    ['gitlab-token', config.gitlabToken],
    ['model', config.model],
    ...(requiresApiKey ? [['api-key', config.apiKey]] : []),
  ]
    .filter(([, value]) => !value)
    .map(([name]) => `--${name}`);

  if (missing.length > 0) {
    const ambientProviders = ['amazon-bedrock', 'google-vertex'];
    const isAmbientProvider = ambientProviders.includes(provider);
    const hints: string[] = [];
    if (missing.includes('--model')) {
      hints.push(
        'Set --model (or GITLAB_REVIEW_MODEL) to a "provider/modelId" value, e.g. anthropic/claude-sonnet-4-5.',
      );
    }
    if (isAmbientProvider) {
      hints.push(
        `Provider "${provider}" requires ambient credentials. For Amazon Bedrock set AWS_ACCESS_KEY_ID / AWS_PROFILE; for Google Vertex run \`gcloud auth application-default login\` and set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.`,
      );
    } else if (missing.includes('--api-key')) {
      hints.push(
        "Set the provider's standard API key env var (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) or pass --api-key.",
      );
    }
    if (hints.length === 0) {
      hints.push('Provide CLI flags or the corresponding GitLab CI environment variables.');
    }
    throw new ConfigError(`Missing required configuration: ${missing.join(', ')}.`, {
      hint: hints.join(' '),
    });
  }

  if (!['info', 'warn', 'critical'].includes(config.minSeverity)) {
    throw new ConfigError('--min-severity must be one of: info, warn, critical');
  }

  if (!THINKING_LEVELS.includes(config.thinkingLevel)) {
    throw new ConfigError(`--thinking must be one of: ${THINKING_LEVELS.join(', ')}`);
  }

  if (!POSTING_MODES.includes(config.postingMode)) {
    throw new ConfigError(`--posting-mode must be one of: ${POSTING_MODES.join(', ')}`);
  }
}

export { type Severity, type ThinkingLevel };
