/**
 * Minimal in-memory MCP server for tests: answers `initialize`, `ping`,
 * `tools/list` (paginated when `pageSize` is set), and `tools/call` over
 * pi-mcp's `createInMemoryTransportPair`. Used by `src/mcp.test.ts` and
 * `tests/evals/mcp-context.eval.ts` — no process is spawned and no network is
 * touched.
 */
import {
  JSON_RPC_ERROR_CODES,
  LATEST_PROTOCOL_VERSION,
  isJsonRpcRequest,
  type CallToolResult,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type Tool,
} from '@earendil-works/pi-mcp';
import {
  createInMemoryTransportPair,
  type InMemoryTransport,
} from '@earendil-works/pi-mcp/testing';

export interface FakeMcpServerOptions {
  name?: string;
  tools: Tool[];
  /** Tools per `tools/list` page. Omitted: every tool in one page. */
  pageSize?: number;
  onCall?: (name: string, args: unknown) => CallToolResult | Promise<CallToolResult>;
}

export interface FakeMcpServer {
  /** Client end of the pair. Single use: one `McpClient.connect` per server. */
  transport: InMemoryTransport;
  calls: { name: string; args: unknown }[];
  /** `tools/list` requests received, one per page. */
  listRequests: number;
  close(): Promise<void>;
}

const echo = (name: string, args: unknown): CallToolResult => ({
  content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }],
});

export async function startFakeMcpServer(options: FakeMcpServerOptions): Promise<FakeMcpServer> {
  const { name = 'fake', tools, pageSize, onCall = echo } = options;
  const { client, server } = createInMemoryTransportPair();
  const fake: FakeMcpServer = {
    transport: client,
    calls: [],
    listRequests: 0,
    close: () => server.close(),
  };

  async function handle(request: JsonRpcRequest): Promise<unknown> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case 'initialize':
        return {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name, version: '1.0.0' },
        };
      case 'ping':
        return {};
      case 'tools/list': {
        fake.listRequests += 1;
        const start = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
        const end = pageSize ? start + pageSize : tools.length;
        return {
          tools: tools.slice(start, end),
          ...(end < tools.length ? { nextCursor: String(end) } : {}),
        };
      }
      case 'tools/call':
        fake.calls.push({ name: String(params.name), args: params.arguments });
        return onCall(String(params.name), params.arguments);
      default:
        throw Object.assign(new Error(`Method not found: ${request.method}`), {
          code: JSON_RPC_ERROR_CODES.methodNotFound,
        });
    }
  }

  server.onMessage((message: JsonRpcMessage) => {
    // Notifications (`initialized`, `cancelled`) need no answer.
    if (!isJsonRpcRequest(message)) return;
    const { id } = message;
    handle(message)
      .then(
        (result) => server.send({ jsonrpc: '2.0', id, result }),
        (error: Error & { code?: number }) =>
          server.send({
            jsonrpc: '2.0',
            id,
            error: {
              code: error.code ?? JSON_RPC_ERROR_CODES.internalError,
              message: error.message,
            },
          }),
      )
      // A late answer after the client timed out or closed has nowhere to go.
      .catch(() => {});
  });
  await server.start();
  return fake;
}
