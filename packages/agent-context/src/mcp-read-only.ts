/** The annotations of an MCP tool that decide whether it is read-only. */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/**
 * Only tools that declare themselves read-only and non-destructive are exposed.
 * An agent that processes attacker-controlled content (a merge request, an
 * issue) must not reach a tool that writes, so a tool with no annotations, or
 * with `readOnlyHint` unset, counts as a write.
 */
export function isReadOnlyMcpTool(tool: { annotations?: McpToolAnnotations }): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
}
