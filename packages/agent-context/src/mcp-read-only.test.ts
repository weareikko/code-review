import { describe, expect, it } from 'vitest';
import { isReadOnlyMcpTool } from './mcp-read-only.js';

describe('isReadOnlyMcpTool', () => {
  it('requires readOnlyHint and rejects destructiveHint', () => {
    expect(isReadOnlyMcpTool({ annotations: { readOnlyHint: true } })).toBe(true);
    expect(isReadOnlyMcpTool({ annotations: { readOnlyHint: true, destructiveHint: false } })).toBe(
      true,
    );
    expect(isReadOnlyMcpTool({ annotations: { readOnlyHint: true, destructiveHint: true } })).toBe(
      false,
    );
    expect(isReadOnlyMcpTool({ annotations: { readOnlyHint: false } })).toBe(false);
    expect(isReadOnlyMcpTool({})).toBe(false);
  });
});
