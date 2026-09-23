import { PRODUCT_URL } from './product.js';
import type { SkillOrigin } from './skills.js';

declare const __PKG_VERSION__: string;

/**
 * Repository coordinates needed to link a skill that lives in the repository
 * under review. Both come from the CI environment: the project's web URL
 * (`CI_PROJECT_URL`, or `GITHUB_SERVER_URL` + `GITHUB_REPOSITORY`) and the
 * reviewed commit. Missing either leaves in-repo skills unlinked.
 */
export interface SkillLinkContext {
  projectWebUrl?: string;
  commitSha?: string;
}

/** A skill as reported in review usage: its name plus where it was loaded from. */
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
 * Build a blob URL for `path` at `ref` inside the repository served at
 * `repoWebUrl`. An empty ref resolves to `HEAD`, which both GitHub and GitLab
 * accept, so a skill pinned to a remote's default branch still links.
 */
export function blobUrl(repoWebUrl: string, ref: string, path: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(repoWebUrl);
  } catch {
    return undefined;
  }
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  const segment = GITHUB_HOSTS.has(parsed.host) ? 'blob' : '-/blob';
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
 * CI project URL). Built-in skills link to the published tag of this package, so
 * the link always shows the skill exactly as the run used it.
 */
export function skillSourceUrl(
  origin: SkillOrigin,
  context: SkillLinkContext = {},
): string | undefined {
  switch (origin.kind) {
    case 'builtin':
      return blobUrl(PRODUCT_URL, __PKG_VERSION__, `skills/${origin.name}/SKILL.md`);
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
 * The name a skill is shown under in the footer. Marketplace skills carry their
 * full selector (`<marketplace>:<plugin>/<skill>`) because a bare skill name says
 * nothing about which marketplace and plugin it came from — and that selector is
 * exactly what a developer would put in `CODE_REVIEW_SKILLS` to use it. Every
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
