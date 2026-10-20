#!/usr/bin/env node
/**
 * Minimal stdio MCP server exposing docs/*.md as read-only tools, plus a
 * write_doc stub proving the read-only gate drops non-read-only tools.
 * Usage: node scripts/docs-mcp.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(HERE, '..', 'docs');

async function listDocNames() {
  const entries = await readdir(DOCS_DIR);
  return entries.filter((name) => name.endsWith('.md')).sort();
}

function firstHeading(content) {
  const line = content.split('\n').find((entry) => entry.startsWith('# '));
  return line ? line.slice(2).trim() : '(no heading)';
}

const server = new McpServer({ name: 'docs', version: '0.0.0' });

server.registerTool(
  'list_docs',
  {
    description: 'List docs/*.md files with their first heading.',
    annotations: { readOnlyHint: true },
  },
  async () => {
    const names = await listDocNames();
    const rows = await Promise.all(
      names.map(async (name) => {
        const content = await readFile(join(DOCS_DIR, name), 'utf8');
        return `${name}: ${firstHeading(content)}`;
      }),
    );
    return { content: [{ type: 'text', text: rows.join('\n') }] };
  },
);

server.registerTool(
  'read_doc',
  {
    description: 'Return the content of one docs/<name>.md file.',
    inputSchema: { name: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ name }) => {
    // Validate against the real directory listing so a crafted name (e.g.
    // `../package.json`) can never resolve outside docs/.
    const names = await listDocNames();
    if (!names.includes(name)) {
      throw new Error(`Unknown doc "${name}". Known docs: ${names.join(', ')}`);
    }
    const text = await readFile(join(DOCS_DIR, name), 'utf8');
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'write_doc',
  {
    description: 'Stub: writing docs is not allowed from the reviewer.',
    inputSchema: { name: z.string(), content: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async () => {
    throw new Error('not allowed');
  },
);

await server.connect(new StdioServerTransport());
