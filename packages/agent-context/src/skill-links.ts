import type { McpServerSource } from './mcp-parse.js';
import type { SkillOrigin } from './skills.js';

/**
 * Where the calling tool publishes its bundled skills, so a built-in skill
 * links to the exact version that ran: code-review passes its repository URL,
 * its package version as `ref`, and `skills` as `path`.
 */
export interface BuiltinSkillsLocation {
  /** Web URL of the tool's repository, such as `https://github.com/weareikko/code-review`. */
  repoWebUrl: string;
  /** Tag, branch or commit to link to — usually the tool's version tag. */
  ref: string;
  /** Directory of the bundled skills in that repository. Defaults to `skills`. */
  path?: string;
}

/**
 * Coordinates needed to link skills and MCP servers. `projectWebUrl` and
 * `commitSha` locate the repository the agent works on; both come from the CI
 * environment: the project's web URL (`CI_PROJECT_URL`, or `GITHUB_SERVER_URL`
 * + `GITHUB_REPOSITORY`) and the commit. Missing either leaves in-repo skills
 * unlinked. Missing `builtinSkills` leaves built-in skills unlinked.
 */
export interface SkillLinkContext {
  projectWebUrl?: string;
  commitSha?: string;
  builtinSkills?: BuiltinSkillsLocation;
}

/** A skill as reported in usage: its name plus where it was loaded from. */
export interface SkillRef {
  name: string;
  origin: SkillOrigin;
}

/**
 * Hosts that serve blobs at `/<repo>/blob/<ref>/<path>`. Everything else is
 * assumed to be GitLab (`/<repo>/-/blob/<ref>/<path>`), which covers both
 * gitlab.com and the self-hosted instances this tool mostly runs against.
 */
const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);

/** Percent-encode each path segment while keeping the `/` separators intact. */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Build a blob (file) or tree (directory) URL for `path` at `ref` inside the
 * repository served at `repoWebUrl`. An empty ref resolves to `HEAD`, which both
 * GitHub and GitLab accept, so a skill or MCP server pinned to a remote's
 * default branch still links.
 */
export function blobUrl(
  repoWebUrl: string,
  ref: string,
  path: string,
  kind: 'blob' | 'tree' = 'blob',
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(repoWebUrl);
  } catch {
    return undefined;
  }
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  const segment = GITHUB_HOSTS.has(parsed.host) ? kind : `-/${kind}`;
  return `${base}/${segment}/${encodeURIComponent(ref || 'HEAD')}/${encodePath(path)}`;
}

/**
 * Convert a git clone URL to the repository's web URL: drop any transport
 * marker, embedded credentials, and the `.git` suffix, and serve it over HTTPS.
 * Accepts `https://`, `ssh://`, `git+<transport>://`, and scp-style
 * (`git@host:group/repo.git`) forms. Returns `undefined` for anything it cannot
 * parse, so an exotic remote simply yields an unlinked skill.
 */
export function gitRepoWebUrl(cloneUrl: string): string | undefined {
  let raw = cloneUrl.trim();
  if (!raw) return undefined;
  if (raw.startsWith('git+')) raw = raw.slice('git+'.length);
  // scp-style `[user@]host:path` — no scheme, and the colon is not a port.
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(raw);
  if (scp) raw = `ssh://${scp[1]}/${scp[2]}`;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (!parsed.host) return undefined;
  const path = parsed.pathname.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  if (!path || path === '/') return undefined;
  // Credentials live in the URL on some CI clone URLs; they must never reach a
  // merge-request note, so only host and path survive.
  return `https://${parsed.host}${path}`;
}

/**
 * Resolve a link to a skill's `SKILL.md`, or `undefined` when the source is not
 * reachable from a browser (a `file:` path, or an in-repo skill on a run with no
 * CI project URL). Built-in skills link to `context.builtinSkills` — the
 * published tag of the calling tool — so the link always shows the skill
 * exactly as the run used it.
 */
export function skillSourceUrl(
  origin: SkillOrigin,
  context: SkillLinkContext = {},
): string | undefined {
  switch (origin.kind) {
    case 'builtin': {
      const builtin = context.builtinSkills;
      if (!builtin) return undefined;
      // `blobUrl` drops empty segments, so an empty or slash-padded `path` is fine.
      const path = `${builtin.path ?? 'skills'}/${origin.name}/SKILL.md`;
      return blobUrl(builtin.repoWebUrl, builtin.ref, path);
    }
    case 'project': {
      if (!context.projectWebUrl || !context.commitSha) return undefined;
      return blobUrl(context.projectWebUrl, context.commitSha, `${origin.path}/SKILL.md`);
    }
    case 'npm':
      return `https://www.npmjs.com/package/${origin.packageName}`;
    case 'file':
      return undefined;
    case 'git':
    case 'marketplace': {
      const repoWebUrl = gitRepoWebUrl(origin.url);
      if (!repoWebUrl) return undefined;
      const path = origin.path ? `${origin.path}/SKILL.md` : 'SKILL.md';
      return blobUrl(repoWebUrl, origin.ref, path);
    }
  }
}

/**
 * Resolve a link to an MCP server's source, or `undefined` when it is not
 * reachable from a browser (a `file:` spec, or a repo `.mcp.json` on a run with
 * no CI project URL). A `project` source links to the `.mcp.json` file it was
 * declared in; a `marketplace` source links to the plugin's directory in the
 * marketplace repository.
 */
export function mcpSourceUrl(
  source: McpServerSource,
  context: SkillLinkContext = {},
): string | undefined {
  switch (source.kind) {
    case 'project': {
      if (!context.projectWebUrl || !context.commitSha) return undefined;
      return blobUrl(context.projectWebUrl, context.commitSha, source.path);
    }
    case 'file':
      return undefined;
    case 'marketplace': {
      const repoWebUrl = gitRepoWebUrl(source.url);
      if (!repoWebUrl) return undefined;
      return blobUrl(repoWebUrl, source.ref, source.path, 'tree');
    }
  }
}

/**
 * The name a skill is shown under in the footer. Marketplace skills carry their
 * full selector (`<marketplace>:<plugin>/<skill>`) because a bare skill name says
 * nothing about which marketplace and plugin it came from — and that selector is
 * exactly what a developer would put in a tool's skill list to use it. Every
 * other source shows the skill's own name.
 */
export function skillDisplayName(skill: SkillRef): string {
  return skill.origin.kind === 'marketplace'
    ? `${skill.origin.marketplace}:${skill.origin.plugin}/${skill.name}`
    : skill.name;
}

/**
 * Render one skill for the summary footer: a link to its source when one can be
 * resolved, otherwise the bare name. The name keeps its code span either way so
 * linked and unlinked skills read the same.
 */
export function formatSkillLink(skill: SkillRef, context: SkillLinkContext = {}): string {
  const name = skillDisplayName(skill);
  const url = skillSourceUrl(skill.origin, context);
  return url ? `[\`${name}\`](${url})` : `\`${name}\``;
}
