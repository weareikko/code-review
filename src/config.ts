import { ConfigError } from './errors.js';
import { POSTING_MODES, type PostingMode } from './posting.js';
import { THINKING_LEVELS, type Severity, type ThinkingLevel } from './types.js';

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
  reviewFile: string;
  output: string;
  dryRun: boolean;
  noPost: boolean;
  postSummary: boolean;
  forceReview: boolean;
  verbose: boolean;
  cwd: string;
  skills: string[];
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

function resolveMinSeverity(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function resolveThinkingLevel(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function resolvePostingMode(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
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

  return {
    project: String(args.project ?? env.CI_PROJECT_ID ?? ''),
    mr: String(args.mr ?? env.CI_MERGE_REQUEST_IID ?? ''),
    gitlabUrl,
    gitlabToken: token.token,
    gitlabAuthHeader: token.header,
    model: String(args.model ?? env.GITLAB_REVIEW_MODEL ?? 'anthropic/claude-sonnet-4-5'),
    minSeverity: resolveMinSeverity(
      args.minSeverity ?? env.GITLAB_REVIEW_MIN_SEVERITY ?? 'info',
    ) as Severity,
    thinkingLevel: resolveThinkingLevel(
      args.thinking ?? env.GITLAB_REVIEW_THINKING_LEVEL ?? 'off',
    ) as ThinkingLevel,
    postingMode: resolvePostingMode(
      args.postingMode ?? env.GITLAB_REVIEW_POSTING_MODE ?? 'direct',
    ) as PostingMode,
    apiKey: String(
      args.apiKey ??
        first(env.GITLAB_REVIEW_API_KEY, env.ANTHROPIC_API_KEY, env.CLAUDE_API_KEY) ??
        '',
    ),
    reviewFile: String(args.reviewFile ?? 'gitlab-review.md'),
    output: String(args.output ?? 'review-comments.json'),
    dryRun: toBoolean(args.dryRun),
    noPost: toBoolean(args.noPost),
    postSummary: resolvePostSummary(args, env),
    forceReview: toBoolean(args.forceReview) || toBoolean(env.GITLAB_REVIEW_FORCE_REVIEW),
    verbose: toBoolean(args.verbose) || toBoolean(env.GITLAB_REVIEW_VERBOSE),
    cwd: String(args.cwd ?? process.cwd()),
    skills: resolveSkills(args, env),
  };
}

export function validateConfig(config: Config): void {
  const missing = [
    ['project', config.project],
    ['mr', config.mr],
    ['gitlab-url', config.gitlabUrl],
    ['gitlab-token', config.gitlabToken],
    ['api-key', config.apiKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => `--${name}`);

  if (missing.length > 0) {
    throw new ConfigError(`Missing required configuration: ${missing.join(', ')}.`, {
      hint: 'Provide CLI flags or the corresponding GitLab CI environment variables.',
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
