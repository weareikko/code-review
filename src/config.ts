export type Severity = 'info' | 'warning' | 'error';

export interface Config {
  project: string;
  mr: string;
  gitlabUrl: string;
  gitlabToken: string;
  model: string;
  minSeverity: Severity;
  apiKey: string;
  reviewFile: string;
  output: string;
  dryRun: boolean;
  noPost: boolean;
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) args[key] = inline;
    else if (rawKey === 'dry-run' || rawKey === 'no-post') args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.length > 0);
}

export function helpText(): string {
  return `Usage: gitlab-review [options]\n\nRuns pi-reviewer and posts deduplicated GitLab MR discussions.\n\nOptions:\n  --project <id>        Defaults to CI_PROJECT_ID\n  --mr <iid>           Defaults to CI_MERGE_REQUEST_IID\n  --gitlab-url <url>   Defaults to CI_SERVER_URL or https://$CI_SERVER_HOST\n  --gitlab-token <tok> Defaults to GITLAB_TOKEN, GLAB_CLI_TOKEN, CI_JOB_TOKEN, GITLAB_PRIVATE_TOKEN\n  --model <model>      Defaults to PI_REVIEWER_MODEL or anthropic/claude-sonnet-4-5\n  --min-severity <s>   info, warning, or error\n  --api-key <key>      Defaults to PI_API_KEY, ANTHROPIC_API_KEY, or CLAUDE_API_KEY\n  --review-file <path> Defaults to pi-review.md\n  --output <path>      Defaults to review-comments.json\n  --dry-run            Write artifacts but do not post\n  --no-post            Write artifacts but do not post\n  --help               Show this help`;
}

export function resolveConfig(argv = process.argv.slice(2), env = process.env): Config {
  const args = parseArgs(argv);
  const gitlabUrl = String(args.gitlabUrl ?? first(env.CI_SERVER_URL, env.CI_SERVER_HOST ? `https://${env.CI_SERVER_HOST}` : undefined) ?? '');
  return {
    project: String(args.project ?? env.CI_PROJECT_ID ?? ''),
    mr: String(args.mr ?? env.CI_MERGE_REQUEST_IID ?? ''),
    gitlabUrl: gitlabUrl.replace(/\/$/, ''),
    gitlabToken: String(args.gitlabToken ?? first(env.GITLAB_TOKEN, env.GLAB_CLI_TOKEN, env.CI_JOB_TOKEN, env.GITLAB_PRIVATE_TOKEN) ?? ''),
    model: String(args.model ?? env.PI_REVIEWER_MODEL ?? 'anthropic/claude-sonnet-4-5'),
    minSeverity: String(args.minSeverity ?? env.PI_REVIEWER_MIN_SEVERITY ?? 'info') as Severity,
    apiKey: String(args.apiKey ?? first(env.PI_API_KEY, env.ANTHROPIC_API_KEY, env.CLAUDE_API_KEY) ?? ''),
    reviewFile: String(args.reviewFile ?? 'pi-review.md'),
    output: String(args.output ?? 'review-comments.json'),
    dryRun: Boolean(args.dryRun),
    noPost: Boolean(args.noPost),
  };
}

export function validateConfig(config: Config): void {
  const missing = [
    ['project', config.project], ['mr', config.mr], ['gitlab-url', config.gitlabUrl],
    ['gitlab-token', config.gitlabToken], ['api-key', config.apiKey],
  ].filter(([, value]) => !value).map(([name]) => `--${name}`);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}. Provide CLI flags or GitLab CI environment variables.`);
  if (!['info', 'warning', 'error'].includes(config.minSeverity)) throw new Error('--min-severity must be one of: info, warning, error');
}
