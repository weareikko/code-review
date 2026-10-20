// Errors
export {
  AgentContextError,
  ConfigError,
  formatError,
  GitError,
  type AgentContextErrorCode,
  type AgentContextErrorOptions,
} from './errors.js';

// Git and paths
export { findGitRoot, git, type GitOptions } from './git.js';
export { toPosixPath, walkDirs } from './paths.js';

// Convention and context files
export {
  CONFIG_DIRS,
  CONVENTION_FILES,
  walkUpContextFiles,
  type ContextFile,
} from './context-files.js';

// Skills
export {
  cloneGitRepo,
  gitSkillCacheKey,
  loadAutoDiscoveredSkills,
  loadBuiltinSkill,
  loadNamedSkill,
  loadSkillFromDir,
  normalizeGitUrl,
  parseSkillSpec,
  redactUrl,
  resolveNpmSkillDir,
  resolveSkillCacheDir,
  type LoadNamedSkillOptions,
  type Skill,
  type SkillOrigin,
  type SkillSpec,
} from './skills.js';
export { loadSkills, type LoadSkillsOptions } from './load-skills.js';

// Marketplaces
export {
  buildMarketplaceRegistry,
  DEFAULT_MARKETPLACE_FORMAT,
  loadMarketplaceMcpServers,
  loadMarketplaceSkill,
  MARKETPLACE_FORMATS,
  parseMarketplaceEntry,
  RESERVED_MARKETPLACE_NAMES,
  type LoadMarketplaceOptions,
  type MarketplaceFormat,
  type MarketplaceMcpSpec,
  type MarketplaceRef,
  type MarketplaceRegistry,
} from './marketplaces.js';

// MCP server configuration
export {
  applyMcpDisableFilters,
  dropEmptyHeaders,
  expandMcpTemplate,
  extractMcpServerMap,
  MAX_MCP_TIMEOUT_MS,
  normalizeMcpServer,
  parseMcpDisableFilters,
  parseMcpServers,
  pickMcpEnvVars,
  type McpDisableFilters,
  type McpEnvVars,
  type McpServerConfig,
  type McpServerSource,
  type McpTransportType,
  type NormalizeMcpServerOptions,
} from './mcp-parse.js';
export {
  loadAutoDiscoveredMcpServers,
  loadMcpDisableFilters,
  parseMcpSpec,
  resolveMcpServers,
  type LoadAutoDiscoveredMcpServersOptions,
  type McpServerSourcesConfig,
  type McpSpec,
  type ResolveMcpServersOptions,
} from './mcp-config.js';
export { isReadOnlyMcpTool, type McpToolAnnotations } from './mcp-read-only.js';

// Links, usage and footer
export {
  blobUrl,
  formatSkillLink,
  gitRepoWebUrl,
  mcpSourceUrl,
  skillDisplayName,
  skillSourceUrl,
  type BuiltinSkillsLocation,
  type SkillLinkContext,
  type SkillRef,
} from './skill-links.js';
export {
  createSkillReadCounter,
  findSkillForPath,
  formatMcpUsageState,
  formatReviewUsageSummary,
  formatSkillUsageState,
  readToolPath,
  type SkillReadCounter,
  type SkillReadTarget,
} from './skill-usage.js';
export {
  formatMcpFooter,
  formatSkillsFooter,
  type McpServerUsage,
  type SkillUsage,
} from './footer.js';
