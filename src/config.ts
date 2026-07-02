import { getEnvApiKey } from '@earendil-works/pi-ai';
import { ConfigError } from './errors.js';
import { POSTING_MODES, type PostingMode } from './posting.js';
import {
  REVIEW_DEPTHS,
  splitModel,
  THINKING_LEVELS,
  type ReviewDepth,
  type Severity,
  type ThinkingLevel,
} from './types.js';

export type GitLabAuthHeader = 'PRIVATE-TOKEN' | 'JOB-TOKEN';

/**
 * The single source of truth for the tool's own `GITLAB_REVIEW_*` settings.
 *
 * Each entry is the suffix after the `GITLAB_REVIEW_` prefix (e.g. `MODEL` for
 * `GITLAB_REVIEW_MODEL`). These are read directly across `config.ts`/`otel.ts`
 * and must NEVER be de-prefixed by {@link applyGitLabReviewEnvPrefix}.
 *
 * Note: `API_KEY` is reserved. `GITLAB_REVIEW_API_KEY` was intentionally retired
 * as the AI provider key and must not be revived as one.
 */
export const RESERVED_ENV_SUFFIXES = [
  'API_KEY',
  'BASE_URL',
  'DECOMPOSE_HINT_LINES',
  'MAX_DIFF_CHARS',
  'MAX_TOKENS',
  'MIN_SEVERITY',
  'MODEL',
  'MODEL_POOL',
  'OTEL',
  'OTEL_CAPTURE_CONTENT',
  'POSTING_MODE',
  'POST_SUMMARY',
  'FORCE_REVIEW',
  'VERBOSE',
  'SKILLS',
  'REFRESH_SKILLS',
  'THINKING_LEVEL',
] as const;

const GITLAB_REVIEW_PREFIX = 'GITLAB_REVIEW_';
const RESERVED_ENV_SUFFIX_SET = new Set<string>(RESERVED_ENV_SUFFIXES);

/**
 * Optional namespacing shim for provider/infra environment variables.
 *
 * For each `GITLAB_REVIEW_<NAME>` variable whose `<NAME>` is not a reserved tool
 * setting (see {@link RESERVED_ENV_SUFFIXES}), this exposes `<NAME>` in the same
 * env object. The prefixed value wins when both `GITLAB_REVIEW_<NAME>` and a
 * plain `<NAME>` are set — the tool's scoped value should override an unrelated
 * CI-wide variable of the same name.
 *
 * This lets credentials and infra vars that `@earendil-works/pi-ai` reads
 * (`ANTHROPIC_API_KEY`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`,
 * `OLLAMA_HOST`, ambient AWS/Vertex creds, …) — and the GitLab tokens — be
 * scoped under `GITLAB_REVIEW_` in shared CI without enumerating pi-ai's
 * provider list.
 *
 * Must run once at startup BEFORE config/key resolution: `getEnvApiKey` and
 * pi-ai's request-time reads both read `process.env` directly, so mutating it
 * in-process is what makes those reads pick up the de-prefixed values.
 *
 * Empty prefixed values are ignored (treated as unset). Double-prefixed names
 * (e.g. `GITLAB_REVIEW_GITLAB_REVIEW_MODEL`) are also skipped so a de-prefixed
 * suffix can never clobber the tool's own reserved `GITLAB_REVIEW_*` settings.
 *
 * @returns the same `env` object it was given, mutated in place.
 */
export function applyGitLabReviewEnvPrefix(env = process.env): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    if (!key.startsWith(GITLAB_REVIEW_PREFIX)) continue;
    const suffix = key.slice(GITLAB_REVIEW_PREFIX.length);
    if (!suffix || RESERVED_ENV_SUFFIX_SET.has(suffix) || suffix.startsWith(GITLAB_REVIEW_PREFIX))
      continue;
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    env[suffix] = value;
  }
  return env;
}

/**
 * Default pi-ai's prompt-cache retention to `long` when the caller has not set
 * it. pi-ai reads `PI_CACHE_RETENTION` from `process.env` at request time; `long`
 * asks providers that support it (e.g. OpenAI's `openai-responses` API, including
 * via the Cloudflare AI Gateway) to keep the cached system-prompt prefix for up
 * to 24h so reviews spaced hours apart still reuse it. It is a safe no-op for
 * providers/models without long-retention support (e.g. Anthropic), where it
 * behaves exactly like the default `short`.
 *
 * Overridable: an explicit `PI_CACHE_RETENTION` (or `GITLAB_REVIEW_PI_CACHE_RETENTION`,
 * mapped by {@link applyGitLabReviewEnvPrefix} first) is left untouched.
 */
export function applyDefaultCacheRetention(env = process.env): NodeJS.ProcessEnv {
  if (!env.PI_CACHE_RETENTION) {
    env.PI_CACHE_RETENTION = 'long';
  }
  return env;
}

export interface Config {
  project: string;
  mr: string;
  gitlabUrl: string;
  gitlabToken: string;
  gitlabAuthHeader: GitLabAuthHeader;
  model: string;
  /**
   * Optional pool of `provider/modelId` models for heterogeneous `full`-depth
   * review. When non-empty, multi-angle Find maps each angle to a pool member and
   * the adversarial verifier prefers a member other than the one that authored a
   * finding. Empty (the default) means the effective pool is just `[model]`, which
   * reproduces single-model behaviour byte-for-byte. Sourced from `--model-pool`
   * or `GITLAB_REVIEW_MODEL_POOL` (comma-separated).
   */
  modelPool: string[];
  minSeverity: Severity;
  thinkingLevel: ThinkingLevel;
  /**
   * How many stages of the review pipeline run. `single` keeps the legacy
   * single-pass behaviour; `verify` adds an adversarial Verify + Synthesize pass.
   */
  reviewDepth: ReviewDepth;
  /**
   * Optional `provider/modelId` for the Verify stage (`verify`/`full` depth). When
   * set, every adversarial verifier runs on this model instead of the pool's
   * cross-family pick — pairing a cheap, high-recall Find model with a strong,
   * high-precision verifier. Empty (default) keeps the pool-based selection.
   * Sourced from `--verify-model` or `GITLAB_REVIEW_VERIFY_MODEL`.
   */
  verifyModel: string;
  postingMode: PostingMode;
  apiKey: string;
  /** Custom base URL for the AI provider API (e.g. Ollama or other OpenAI-compatible endpoints). */
  baseUrl: string;
  /** Maximum output tokens to request from the model. 0 uses the model's default. */
  maxTokens: number;
  /**
   * Maximum cumulative diff characters sent to the reviewer. Files past this
   * budget are dropped and surfaced as a size-skip callout. Defaults to 100_000.
   */
  maxDiffChars: number;
  /**
   * When > 0, an MR whose reviewed diff changes more lines than this threshold
   * gets a "consider decomposing this MR" hint in the summary. 0 = off (default).
   */
  decomposeHintLines: number;
  /**
   * Lines of surrounding context per diff hunk (`git diff --unified`). More
   * context helps the model reason about each change but inflates tokens and
   * fits fewer files in the char budget; less context fits more files. 0 uses
   * the built-in default. Sourced from `--diff-context` / `GITLAB_REVIEW_DIFF_CONTEXT`.
   */
  diffContext: number;
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
export function resolveProviderApiKey(model: string): string {
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

/**
 * Resolve the model pool from `--model-pool` (preferred) or
 * `GITLAB_REVIEW_MODEL_POOL`. Both are comma-separated `provider/modelId` lists.
 * Entries are trimmed and empty entries dropped. Returns `[]` when unset, which
 * downstream treats as "use the single `config.model`".
 */
function resolveModelPool(args: ParsedArgs, env: NodeJS.ProcessEnv): string[] {
  const raw =
    (typeof args.modelPool === 'string' && args.modelPool.length > 0
      ? args.modelPool
      : env.GITLAB_REVIEW_MODEL_POOL) ?? '';
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
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

  const DEFAULT_MAX_DIFF_CHARS = 100_000;
  const rawMaxDiffChars = Number(args.maxDiffChars ?? env.GITLAB_REVIEW_MAX_DIFF_CHARS);
  const maxDiffChars =
    Number.isFinite(rawMaxDiffChars) && rawMaxDiffChars > 0
      ? rawMaxDiffChars
      : DEFAULT_MAX_DIFF_CHARS;

  const rawDecomposeHintLines = Number(
    args.decomposeHintLines ?? env.GITLAB_REVIEW_DECOMPOSE_HINT_LINES ?? 0,
  );
  const decomposeHintLines =
    Number.isFinite(rawDecomposeHintLines) && rawDecomposeHintLines > 0 ? rawDecomposeHintLines : 0;

  const rawDiffContext = Number(args.diffContext ?? env.GITLAB_REVIEW_DIFF_CONTEXT);
  const diffContext =
    Number.isFinite(rawDiffContext) && rawDiffContext >= 0 ? Math.floor(rawDiffContext) : 0;

  return {
    project: String(args.project ?? env.CI_PROJECT_ID ?? ''),
    mr: String(args.mr ?? env.CI_MERGE_REQUEST_IID ?? ''),
    gitlabUrl,
    gitlabToken: token.token,
    gitlabAuthHeader: token.header,
    model,
    modelPool: resolveModelPool(args, env),
    minSeverity: normalizeChoice(
      args.minSeverity ?? env.GITLAB_REVIEW_MIN_SEVERITY ?? 'info',
    ) as Severity,
    thinkingLevel: normalizeChoice(
      args.thinking ?? env.GITLAB_REVIEW_THINKING_LEVEL ?? 'off',
    ) as ThinkingLevel,
    reviewDepth: normalizeChoice(
      args.reviewDepth ?? env.GITLAB_REVIEW_DEPTH ?? 'single',
    ) as ReviewDepth,
    verifyModel: String(args.verifyModel ?? env.GITLAB_REVIEW_VERIFY_MODEL ?? ''),
    postingMode: normalizeChoice(
      args.postingMode ?? env.GITLAB_REVIEW_POSTING_MODE ?? 'direct',
    ) as PostingMode,
    apiKey,
    baseUrl,
    maxTokens,
    maxDiffChars,
    decomposeHintLines,
    diffContext,
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

  if (!REVIEW_DEPTHS.includes(config.reviewDepth)) {
    throw new ConfigError(`--review-depth must be one of: ${REVIEW_DEPTHS.join(', ')}`);
  }

  if (!POSTING_MODES.includes(config.postingMode)) {
    throw new ConfigError(`--posting-mode must be one of: ${POSTING_MODES.join(', ')}`);
  }
}

export { type Severity, type ThinkingLevel };
