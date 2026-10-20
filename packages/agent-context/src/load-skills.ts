import { formatError } from './errors.js';
import {
  buildMarketplaceRegistry,
  loadMarketplaceSkill,
  type MarketplaceRef,
} from './marketplaces.js';
import { loadAutoDiscoveredSkills, loadNamedSkill, parseSkillSpec, type Skill } from './skills.js';

/** Options for `loadSkills`. */
export interface LoadSkillsOptions {
  /** The clone cache for `git:` skills and marketplaces, usually `resolveSkillCacheDir(product)`. */
  cacheDir: string;
  /** Re-clone `git:` skills and marketplaces, bypassing the on-disk clone cache. */
  refresh?: boolean;
  /** Registered Claude-plugin marketplaces referenced by name in skill specs. */
  marketplaces?: readonly MarketplaceRef[];
  /** The calling tool's bundled skills, which bare names resolve against. */
  builtinSkillsDir?: string;
  /** The tool's environment variable prefix (`CODE_REVIEW_`), named in hints. */
  envPrefix?: string;
  warn?: (msg: string) => void;
}

/**
 * Every skill for a run: the skills auto-discovered in the repository
 * (`.agents/skills` and `.claude/skills`, walked from `gitRoot` to `cwd`), then
 * each spec in `specs` that does not name an auto-discovered skill.
 *
 * A skill is auxiliary guidance, so a spec that fails to load (an external
 * `git:` clone that cannot be downloaded, a missing file, an unknown
 * marketplace plugin) is skipped with a warning instead of failing the run.
 */
export async function loadSkills(
  cwd: string,
  gitRoot: string,
  specs: readonly string[],
  options: LoadSkillsOptions,
): Promise<Skill[]> {
  const { warn } = options;
  const discovered = await loadAutoDiscoveredSkills(cwd, gitRoot, warn);

  const registry = buildMarketplaceRegistry(options.marketplaces ?? []);
  const knownMarketplaces = new Set(registry.keys());

  const discoveredNames = new Set(discovered.map((s) => s.name));
  const named = await Promise.all(
    specs
      .filter((n) => !discoveredNames.has(n))
      .map(async (n) => {
        try {
          const spec = parseSkillSpec(n, knownMarketplaces);
          if (spec.protocol === 'marketplace') {
            return await loadMarketplaceSkill(spec, registry, {
              cacheDir: options.cacheDir,
              refresh: options.refresh,
              envPrefix: options.envPrefix,
            });
          }
          return await loadNamedSkill(n, cwd, {
            cacheDir: options.cacheDir,
            refresh: options.refresh,
            builtinSkillsDir: options.builtinSkillsDir,
          });
        } catch (error) {
          warn?.(`Skipping skill "${n}": ${formatError(error)}`);
          return null;
        }
      }),
  );
  return [...discovered, ...named.filter((s): s is Skill => s !== null)];
}
