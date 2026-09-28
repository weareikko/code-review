/**
 * MCP context lookup eval.
 *
 * Two properties, both about the reviewer's *behaviour* around external
 * context, not about code-defect recall:
 *
 * 1. **It looks up a structured identifier.** An MR that says "Closes #7" and
 *    lowers a constant must make the reviewer read issue 7 through the
 *    connected `tracker` MCP server, and report that the change contradicts
 *    what the issue asks for (raise to 60 — the diff lowers to 20).
 * 2. **It stays quiet otherwise.** The same diff with a description that
 *    references nothing external must produce zero MCP calls: a connected
 *    server is not an invitation to browse.
 *
 * The server is an in-memory fake (SDK low-level `Server` + `InMemoryTransport`,
 * the pattern from `src/mcp.test.ts`), wired through `runReview`'s public
 * `connectMcp` option — no process is spawned and no network is touched. Only
 * the reviewer and the judge call real models.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// The low-level `Server` accepts raw JSON-schema tool definitions, which is what
// the bridge consumes; `McpServer` would need zod schemas.
// oxlint-disable-next-line typescript/no-deprecated
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';
import type { HarnessRun, TranscriptEvent } from 'vitest-evals';
// oxlint-disable eslint-plugin-jest/no-standalone-expect -- describeEval uses its own `it` wrapper that oxlint doesn't recognise
import { createHarness, describeEval } from 'vitest-evals';
import type { Config } from '../../src/config.js';
import { resolveProviderApiKey } from '../../src/config.js';
import { runReview } from '../../src/gitlab-review.js';
import type { McpServerConfig } from '../../src/mcp-config.js';
import { connectMcpServers } from '../../src/mcp.js';
import { parseReviewMarkdownWithWarnings } from '../../src/parser.js';
import { createLlmJudge } from './llm-judge.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Runs per case. Both thresholds below are expressed against this number. */
const TRIALS = Number(process.env.MCP_CONTEXT_TRIALS) || 3;

const EVAL_MODEL = process.env.CODE_REVIEW_EVAL_MODEL ?? 'openrouter/openai/gpt-5.6-luna';

// --- The fake tracker server ----------------------------------------------

const ISSUE_7 = [
  'Issue #7 — Raise the default call budget to 60',
  'Status: open',
  '',
  'Description:',
  'Reviews on large merge requests run out of tool calls before they finish.',
  'Raise the default call budget from 40 to 60.',
  '',
  'Acceptance criteria:',
  '- DEFAULT_CALL_BUDGET is raised to 60.',
  '- The limits table in the docs is updated to match.',
].join('\n');

const TRACKER_TOOLS: McpTool[] = [
  {
    name: 'issue_read',
    description: 'Read one issue from the tracker by its number. Returns title, status, and body.',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'string', description: 'Issue number, e.g. "7".' },
      },
      required: ['issue'],
    },
    annotations: { readOnlyHint: true },
  },
];

interface TrackerServer {
  transport: InMemoryTransport;
  close: () => Promise<void>;
}

function issueText(issue: unknown): string {
  return String(issue ?? '').replace(/^#/, '') === '7'
    ? ISSUE_7
    : `No issue ${String(issue ?? '')} in this tracker.`;
}

async function startTrackerServer(): Promise<TrackerServer> {
  // oxlint-disable-next-line typescript/no-deprecated
  const server = new Server({ name: 'tracker', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TRACKER_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    const args = request.params.arguments as { issue?: unknown } | undefined;
    return { content: [{ type: 'text', text: issueText(args?.issue) }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { transport: clientTransport, close: () => server.close() };
}

const TRACKER_CONFIG: McpServerConfig = {
  name: 'tracker',
  type: 'stdio',
  command: 'tracker-mcp',
  args: [],
  env: {},
  headers: {},
  source: { kind: 'file', path: 'tests/evals/mcp-context.eval.ts' },
};

// --- Harness ---------------------------------------------------------------

type EvalInput = {
  diff: string;
  intent: { title: string; description: string };
};

type EvalOutput = {
  summary: string;
  comments: Array<{ file: string; line: number; severity: string; body: string }>;
  /** Connection outcome for the `tracker` server: `'missing'` when no entry was reported. */
  trackerStatus: string;
  /** Tools the bridge exposed to the reviewer from the `tracker` server. */
  trackerTools: string[];
  /** Calls the reviewer made against the `tracker` server during this run. */
  trackerCalls: number;
  cost: number;
};

function makeConfig(cwd: string): Config {
  const model = EVAL_MODEL;
  return {
    project: 'test',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'test',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model,
    modelPool: [],
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    reviewDepth: 'single',
    apiKey: resolveProviderApiKey(model),
    baseUrl: process.env.CODE_REVIEW_BASE_URL ?? '',
    maxTokens: Number(process.env.CODE_REVIEW_MAX_TOKENS ?? 0),
    maxDiffChars: 100_000,
    decomposeHintLines: 0,
    reviewFile: 'code-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: true,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd,
    skills: [],
    refreshGitSkills: false,
  };
}

const mcpHarness = createHarness<EvalInput, EvalOutput, Record<string, unknown>>({
  name: 'mcp-context',
  run: async ({ input }) => {
    const dir = await mkdtemp(join(tmpdir(), 'code-review-mcp-eval-'));
    const tracker = await startTrackerServer();
    try {
      const usage = await runReview(makeConfig(dir), {
        diff: input.diff,
        intent: input.intent,
        // The library seam: resolved configs are replaced by the fake server,
        // and the transport is the in-memory pair instead of a spawned process.
        connectMcp: (_configs, options) =>
          connectMcpServers([TRACKER_CONFIG], {
            ...options,
            createTransport: () => tracker.transport,
          }),
      });

      const raw = await readFile(join(dir, 'code-review.md'), 'utf8');
      const parsed = parseReviewMarkdownWithWarnings(raw);
      // Carried into the output so both cases can assert the bridge actually
      // worked: a server that failed to connect also reports zero calls, which
      // would make the "stays quiet" case pass for the wrong reason.
      const trackerUsage = usage.mcp.find((server) => server.name === 'tracker');
      const output: EvalOutput = {
        summary: parsed.summary ?? '',
        comments: parsed.comments.map((c) => ({
          file: c.file,
          line: c.line,
          severity: c.severity,
          body: c.body,
        })),
        trackerStatus: trackerUsage?.status ?? 'missing',
        trackerTools: trackerUsage?.exposedTools ?? [],
        trackerCalls: trackerUsage?.calls ?? -1,
        cost: usage.cost.total,
      };

      const events: TranscriptEvent[] = [
        { type: 'message', role: 'user', content: input.diff },
        { type: 'message', role: 'assistant', content: raw },
      ];

      return {
        output,
        events,
        usage: {
          provider: 'openrouter',
          model: usage.model,
          inputTokens: usage.tokens.input,
          outputTokens: usage.tokens.output,
          totalTokens: usage.tokens.total,
        },
      };
    } finally {
      await tracker.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
});

// --- Judge -----------------------------------------------------------------

const ContradictsIssueJudge = createLlmJudge<EvalInput, EvalOutput>(
  'ContradictsIssueJudge',
  'The review must state that the change contradicts the referenced issue: the issue asks for the default call budget to be RAISED to 60, and the diff LOWERS it to 20. Passing requires both the direction of the conflict and the numbers (60 asked, 20 implemented, or the 40 → 20 change against a 60 target). A generic remark that the constant changed, or that the intent is unclear, does NOT pass.',
);

/**
 * Score one already-produced review with the judge. The suite runs each case
 * several times and thresholds the tally itself, so the judge is called here
 * rather than through the automatic per-run judge path.
 */
async function judgeOnce(
  input: EvalInput,
  output: EvalOutput,
  run: HarnessRun<EvalOutput>,
): Promise<number> {
  const verdict = await ContradictsIssueJudge.assess({
    input,
    output,
    toolCalls: [],
    run,
    session: run.session,
    harness: {},
  });
  return verdict.score ?? 0;
}

const missingApiKey = () => !resolveProviderApiKey(EVAL_MODEL);

/**
 * Fail loudly when the bridge itself broke. Without this, a server that never
 * connected — or whose `issue_read` was dropped by the read-only gate or a name
 * collision — reports zero calls, and the "stays quiet" case passes vacuously.
 */
function expectTrackerWired(output: EvalOutput): void {
  expect(output.trackerStatus).toBe('connected');
  expect(output.trackerTools).toContain('issue_read');
}

// --- Cases -----------------------------------------------------------------

describeEval(
  'MCP context lookup',
  {
    harness: mcpHarness,
    judges: [],
    judgeThreshold: null,
    skipIf: missingApiKey,
  },
  (it) => {
    it(
      'resolves a referenced issue through MCP and reports the contradiction',
      { timeout: 180_000 * TRIALS },
      async ({ run }) => {
        const diff = await readFile(join(FIXTURES, 'call-budget-lowered.diff'), 'utf8');
        const input: EvalInput = {
          diff,
          intent: { title: 'Lower the default call budget', description: 'Closes #7' },
        };

        let calledTracker = 0;
        let judged = 0;
        let cost = 0;
        for (let trial = 0; trial < TRIALS; trial += 1) {
          const result = await run(input);
          const output = result.output;
          cost += output.cost;
          expectTrackerWired(output);
          if (output.trackerCalls >= 1) calledTracker += 1;
          judged += await judgeOnce(input, output, result);
        }

        // oxlint-disable-next-line no-console
        console.log(
          `\n=== MCP context — issue referenced (${TRIALS} trials, ${EVAL_MODEL}) ===\n` +
            `tracker called: ${calledTracker}/${TRIALS}\n` +
            `contradiction reported: ${judged}/${TRIALS}\n` +
            `cost: $${cost.toFixed(5)}`,
        );

        expect(calledTracker).toBe(TRIALS);
        expect(judged).toBeGreaterThanOrEqual(Math.ceil((TRIALS * 2) / 3));
      },
    );

    it(
      'makes no MCP call when nothing references external context',
      { timeout: 180_000 * TRIALS },
      async ({ run }) => {
        const diff = await readFile(join(FIXTURES, 'call-budget-lowered.diff'), 'utf8');
        const input: EvalInput = {
          diff,
          intent: { title: 'Lower the default call budget', description: 'Tidy constant naming' },
        };

        let quiet = 0;
        let cost = 0;
        for (let trial = 0; trial < TRIALS; trial += 1) {
          const result = await run(input);
          const output = result.output;
          cost += output.cost;
          expectTrackerWired(output);
          if (output.trackerCalls === 0) quiet += 1;
        }

        // oxlint-disable-next-line no-console
        console.log(
          `\n=== MCP context — no identifier (${TRIALS} trials, ${EVAL_MODEL}) ===\n` +
            `no tracker call: ${quiet}/${TRIALS}\n` +
            `cost: $${cost.toFixed(5)}`,
        );

        expect(quiet).toBe(TRIALS);
      },
    );
  },
);
