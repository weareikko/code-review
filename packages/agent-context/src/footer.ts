import type { McpServerSource } from './mcp-parse.js';
import {
  formatSkillLink,
  mcpSourceUrl,
  type SkillLinkContext,
  type SkillRef,
} from './skill-links.js';
import { formatMcpUsageState, formatSkillUsageState } from './skill-usage.js';

/** A skill as shown in the footer: where it came from and how many of its files were read. */
export interface SkillUsage extends SkillRef {
  reads: number;
}

/** An MCP server as shown in the footer: where it came from and how it was used. */
export interface McpServerUsage {
  name: string;
  source: McpServerSource;
  status: 'connected' | 'unavailable';
  calls: number;
}

/**
 * The footer's skills line. Each skill links to its `SKILL.md` source so a
 * developer reading the note can check what the agent was told; skills with no
 * reachable source (a `file:` path, or an in-repo skill on a run without CI
 * project coordinates) stay as plain names.
 */
export function formatSkillsFooter(
  skills: readonly SkillUsage[],
  context: SkillLinkContext = {},
): string | undefined {
  if (skills.length === 0) return undefined;
  const parts = skills.map(
    (skill) => `${formatSkillLink(skill, context)} (${formatSkillUsageState(skill)})`,
  );
  return `Skills: ${parts.join(', ')}`;
}

/**
 * The footer's MCP line, e.g. `MCP: jira (2 calls), docs (unused), context7
 * (unavailable)`. A connected server reports how many tool calls the agent
 * actually made against it; an unavailable one is flagged as such. The footer
 * answers what was used, not what was offered. Each server name links to its
 * source (the repo `.mcp.json` or the marketplace plugin) when one is
 * reachable, the same way `formatSkillsFooter` links skills.
 */
export function formatMcpFooter(
  servers: readonly McpServerUsage[],
  context: SkillLinkContext = {},
): string | undefined {
  if (servers.length === 0) return undefined;
  const parts = servers.map((server) => {
    const url = mcpSourceUrl(server.source, context);
    const name = url ? `[${server.name}](${url})` : server.name;
    return `${name} (${formatMcpUsageState(server)})`;
  });
  return `MCP: ${parts.join(', ')}`;
}
