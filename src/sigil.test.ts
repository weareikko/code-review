import { describe, expect, it, vi } from 'vitest';
import type { Config, SigilContentCaptureMode } from './config.js';
import { ReviewerError } from './errors.js';
import type { ToolTiming, TurnData } from './gitlab-review.js';
import {
  createDiagnosticContext,
  diagnosticChannels,
  traceDiagnostic,
  type DiagnosticContext,
} from './review.js';
import type { SigilBridgeOptions, SigilClientLike } from './sigil.js';

function makeTurnData(overrides: Partial<TurnData> = {}): TurnData {
  const now = new Date('2025-01-01T00:00:00.000Z');
  return {
    conversationId: 'conv-1',
    turnIndex: 1,
    startedAt: now,
    completedAt: new Date(now.getTime() + 3000),
    firstTokenAt: new Date(now.getTime() + 500),
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    thinkingEnabled: false,
    toolTimings: [],
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 10,
      totalTokens: 1260, // all-in from provider
    },
    stopReason: 'end_turn',
    ...overrides,
  };
}

describe('Sigil bridge', () => {
  interface SigilGenerationStart {
    conversationId?: string;
    agentName?: string;
    agentVersion?: string;
    model: { provider: string; name: string };
    contentCapture?: string;
    thinkingEnabled?: boolean;
    startedAt?: Date;
    metadata?: Record<string, unknown>;
  }

  interface SigilGenerationResult {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
    };
    completedAt?: Date;
    stopReason?: string;
    metadata?: Record<string, unknown>;
  }

  interface RecordedGeneration {
    start: SigilGenerationStart;
    result: SigilGenerationResult | undefined;
    callError: unknown;
    ended: boolean;
    firstTokenAt: Date | undefined;
    /** Whether this was opened via startStreamingGeneration (vs. startGeneration). */
    streaming: boolean;
  }

  interface RecordedToolExecution {
    toolName: string;
    toolCallId?: string;
    conversationId?: string;
    requestModel?: string;
    requestProvider?: string;
    startedAt?: Date;
    completedAt: Date | undefined;
    callError: unknown;
    ended: boolean;
  }

  function createFakeClient(): {
    client: SigilClientLike;
    generations: RecordedGeneration[];
    toolExecutions: RecordedToolExecution[];
    shutdown: ReturnType<typeof vi.fn>;
  } {
    const generations: RecordedGeneration[] = [];
    const toolExecutions: RecordedToolExecution[] = [];
    const shutdown = vi.fn(async () => undefined);

    function makeGenerationRecorder(gen: RecordedGeneration) {
      return {
        setResult(result: SigilGenerationResult) {
          gen.result = result;
        },
        setCallError(error: unknown) {
          gen.callError = error;
        },
        setFirstTokenAt(date: Date) {
          gen.firstTokenAt = date;
        },
        end() {
          gen.ended = true;
        },
      };
    }

    const client: SigilClientLike = {
      startGeneration(start: SigilGenerationStart) {
        const gen: RecordedGeneration = {
          start,
          result: undefined,
          callError: undefined,
          ended: false,
          firstTokenAt: undefined,
          streaming: false,
        };
        generations.push(gen);
        return makeGenerationRecorder(gen);
      },
      async startStreamingGeneration<T>(
        start: SigilGenerationStart,
        callback: (recorder: ReturnType<typeof makeGenerationRecorder>) => Promise<T>,
      ): Promise<T> {
        const gen: RecordedGeneration = {
          start,
          result: undefined,
          callError: undefined,
          ended: false,
          firstTokenAt: undefined,
          streaming: true,
        };
        generations.push(gen);
        const recorder = makeGenerationRecorder(gen);
        try {
          return await callback(recorder);
        } finally {
          gen.ended = true;
        }
      },
      startToolExecution(start: {
        toolName: string;
        toolCallId?: string;
        conversationId?: string;
        requestModel?: string;
        requestProvider?: string;
        startedAt?: Date;
      }) {
        const exec: RecordedToolExecution = {
          toolName: start.toolName,
          toolCallId: start.toolCallId,
          conversationId: start.conversationId,
          requestModel: start.requestModel,
          requestProvider: start.requestProvider,
          startedAt: start.startedAt,
          completedAt: undefined,
          callError: undefined,
          ended: false,
        };
        toolExecutions.push(exec);
        return {
          setResult(result: { completedAt?: Date }) {
            exec.completedAt = result.completedAt;
          },
          setCallError(error: unknown) {
            exec.callError = error;
          },
          end() {
            exec.ended = true;
          },
        };
      },
      shutdown,
    };

    return { client, generations, toolExecutions, shutdown };
  }

  const baseConfig: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 't',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    apiKey: 'k',
    reviewFile: 'gitlab-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: '/tmp',
    skills: [],
    sigil: false,
    sigilCaptureMode: 'metadata_only',
  };

  async function runWithBridge(
    work: (ctx: DiagnosticContext) => Promise<void>,
    opts: { captureMode?: SigilContentCaptureMode; runId?: string } = {},
  ): Promise<ReturnType<typeof createFakeClient>> {
    const { startSigilBridge } = await import('./sigil.js');
    const fake = createFakeClient();
    const bridgeOptions: SigilBridgeOptions = {
      client: fake.client,
      env: { GITLAB_REVIEW_SIGIL: '1' },
      captureMode: opts.captureMode,
    };
    const bridge = await startSigilBridge(bridgeOptions);
    expect(bridge).not.toBeNull();

    const runId = opts.runId ?? 'run-sigil';
    const ctx = createDiagnosticContext('run', baseConfig, runId);
    try {
      await traceDiagnostic(diagnosticChannels.run, ctx, async (c) => {
        await work(c);
      });
    } catch {
      // Swallow — error-path tests assert on captured generations.
    } finally {
      await bridge?.shutdown();
    }
    return fake;
  }

  it('returns false from isSigilEnabled unless GITLAB_REVIEW_SIGIL is opted in', async () => {
    const { isSigilEnabled } = await import('./sigil.js');
    expect(isSigilEnabled({})).toBe(false);
    expect(isSigilEnabled({ GITLAB_REVIEW_SIGIL: '0' })).toBe(false);
    expect(isSigilEnabled({ GITLAB_REVIEW_SIGIL: 'yes' })).toBe(false);
    expect(isSigilEnabled({ GITLAB_REVIEW_SIGIL: '1' })).toBe(true);
    expect(isSigilEnabled({ GITLAB_REVIEW_SIGIL: 'true' })).toBe(true);
  });

  it('returns null when disabled without touching the client', async () => {
    const { startSigilBridge } = await import('./sigil.js');
    const fake = createFakeClient();
    const result = await startSigilBridge({ client: fake.client, env: {} });
    expect(result).toBeNull();
    expect(fake.generations).toHaveLength(0);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('calls startGeneration on reviewer.run start', async () => {
    const { generations } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });

    expect(generations).toHaveLength(1);
    const gen = generations[0];
    expect(gen.start.model).toEqual({ provider: 'anthropic', name: 'claude-sonnet-4-5' });
    expect(gen.start.agentName).toBe('gitlab-review');
    expect(gen.start.conversationId).toBe('run-sigil');
    expect(gen.start.contentCapture).toBe('metadata_only');
  });

  it('sets project and MR metadata in startGeneration', async () => {
    const { generations } = await runWithBridge(async () => {});

    const meta = generations[0].start.metadata;
    expect(meta).toMatchObject({
      'gitlab.project_id': 'proj',
      'gitlab.mr_iid': '1',
      'gitlab.server_url': 'https://gitlab.example.com',
      'gitlab_review.run_id': 'run-sigil',
      'gitlab_review.dry_run': false,
      'gitlab_review.no_post': false,
      'gitlab_review.min_severity': 'info',
    });
  });

  it('sets result with usage and result metadata on asyncEnd', async () => {
    const { generations } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 1200, output: 340, cacheRead: 50, cacheWrite: 10, total: 1600 },
        cost: { input: 0.012, output: 0.034, cacheRead: 0.001, cacheWrite: 0.002, total: 0.049 },
      };
      ctx.generated = 7;
      ctx.newComments = 5;
      ctx.duplicateComments = 2;
    });

    const gen = generations[0];
    expect(gen.ended).toBe(true);
    expect(gen.callError).toBeUndefined();
    expect(gen.result?.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 340,
      // totalTokens = input + output only (OTel gen_ai convention); cache tokens
      // are separate fields and must not inflate this value.
      totalTokens: 1540,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 10,
    });
    expect(gen.result?.metadata).toMatchObject({
      'gitlab_review.comments.generated': 7,
      'gitlab_review.comments.new': 5,
      'gitlab_review.comments.duplicate': 2,
    });
  });

  it('omits zero cache token fields from usage', async () => {
    const { generations } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });

    const usage = generations[0].result?.usage;
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    expect(usage).not.toHaveProperty('cacheReadInputTokens');
    expect(usage).not.toHaveProperty('cacheWriteInputTokens');
  });

  it('calls setCallError and ends on reviewer.run error', async () => {
    const { generations } = await runWithBridge(async () => {
      throw new ReviewerError('reviewer timed out');
    });

    const gen = generations[0];
    expect(gen.ended).toBe(true);
    expect(gen.result).toBeUndefined();
    expect(gen.callError).toBeInstanceOf(Error);
    expect((gen.callError as Error).message).toBe('reviewer timed out');
    expect((gen.callError as Error).name).toBe('ReviewerError');
  });

  it('respects captureMode option and passes it to the SDK', async () => {
    const { generations } = await runWithBridge(async () => {}, {
      captureMode: 'no_tool_content',
    });
    expect(generations[0].start.contentCapture).toBe('no_tool_content');
  });

  it('reads captureMode from SIGIL_CONTENT_CAPTURE_MODE env when not overridden', async () => {
    const { startSigilBridge } = await import('./sigil.js');
    const fake = createFakeClient();
    const bridge = await startSigilBridge({
      client: fake.client,
      env: { GITLAB_REVIEW_SIGIL: '1', SIGIL_CONTENT_CAPTURE_MODE: 'full' },
    });
    const ctx = createDiagnosticContext('run', baseConfig, 'run-env-mode');
    await traceDiagnostic(diagnosticChannels.run, ctx, async () => {});
    await bridge?.shutdown();

    expect(fake.generations[0].start.contentCapture).toBe('full');
  });

  it('falls back to metadata_only for unknown capture mode values', async () => {
    const { startSigilBridge } = await import('./sigil.js');
    const fake = createFakeClient();
    const bridge = await startSigilBridge({
      client: fake.client,
      env: { GITLAB_REVIEW_SIGIL: '1', SIGIL_CONTENT_CAPTURE_MODE: 'invalid-mode' },
    });
    const ctx = createDiagnosticContext('run', baseConfig, 'run-fallback');
    await traceDiagnostic(diagnosticChannels.run, ctx, async () => {});
    await bridge?.shutdown();

    expect(fake.generations[0].start.contentCapture).toBe('metadata_only');
  });

  it('awaits client.shutdown when the bridge stops', async () => {
    const { startSigilBridge } = await import('./sigil.js');
    const fake = createFakeClient();
    const bridge = await startSigilBridge({
      client: fake.client,
      env: { GITLAB_REVIEW_SIGIL: '1' },
    });
    await bridge?.shutdown();
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('handles model without provider prefix', async () => {
    const configNoProvider: Config = { ...baseConfig, model: 'claude-sonnet-4-5' };
    const { startSigilBridge } = await import('./sigil.js');
    const fake = createFakeClient();
    const bridge = await startSigilBridge({
      client: fake.client,
      env: { GITLAB_REVIEW_SIGIL: '1' },
    });
    const ctx = createDiagnosticContext('run', configNoProvider, 'run-no-provider');
    await traceDiagnostic(diagnosticChannels.run, ctx, async () => {});
    await bridge?.shutdown();

    expect(fake.generations[0].start.model.provider).toBe('unknown');
    expect(fake.generations[0].start.model.name).toBe('claude-sonnet-4-5');
  });

  // ---------------------------------------------------------------------------
  // createTurnHandler — per-turn streaming generation and tool spans
  // ---------------------------------------------------------------------------

  async function startBridgeWithFake(opts: SigilBridgeOptions = {}) {
    const { startSigilBridge } = await import('./sigil.js');
    const fake = createFakeClient();
    const bridge = await startSigilBridge({
      client: fake.client,
      env: { GITLAB_REVIEW_SIGIL: '1' },
      ...opts,
    });
    return { fake, bridge };
  }

  it('createTurnHandler emits a streaming generation per turn', async () => {
    const { fake, bridge } = await startBridgeWithFake();
    const handler = bridge!.createTurnHandler();
    await handler(makeTurnData());
    await bridge!.shutdown();

    // Should have 0 run-level generations (none triggered) plus 1 streaming turn.
    const streaming = fake.generations.filter((g) => g.streaming);
    expect(streaming).toHaveLength(1);
    const gen = streaming[0];
    expect(gen.start.model).toEqual({ provider: 'anthropic', name: 'claude-sonnet-4-5' });
    expect(gen.start.conversationId).toBe('conv-1');
    expect(gen.start.agentName).toBe('gitlab-review');
    expect(gen.start.contentCapture).toBe('metadata_only');
    expect(gen.ended).toBe(true);
  });

  it('createTurnHandler sets TTFT on the generation recorder', async () => {
    const { fake, bridge } = await startBridgeWithFake();
    const firstTokenAt = new Date('2025-01-01T00:00:00.500Z');
    await bridge!.createTurnHandler()(makeTurnData({ firstTokenAt }));
    await bridge!.shutdown();

    const gen = fake.generations.find((g) => g.streaming)!;
    expect(gen.firstTokenAt).toEqual(firstTokenAt);
  });

  it('createTurnHandler omits setFirstTokenAt when firstTokenAt is absent', async () => {
    const { fake, bridge } = await startBridgeWithFake();
    await bridge!.createTurnHandler()(makeTurnData({ firstTokenAt: undefined }));
    await bridge!.shutdown();

    const gen = fake.generations.find((g) => g.streaming)!;
    expect(gen.firstTokenAt).toBeUndefined();
  });

  it('createTurnHandler sets result with OTel-convention totalTokens', async () => {
    const { fake, bridge } = await startBridgeWithFake();
    await bridge!.createTurnHandler()(
      makeTurnData({
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 50,
          cacheWriteInputTokens: 10,
          totalTokens: 1260, // all-in; bridge should NOT use this
        },
      }),
    );
    await bridge!.shutdown();

    const gen = fake.generations.find((g) => g.streaming)!;
    expect(gen.result?.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      // totalTokens = input + output (OTel convention), NOT the all-in 1260.
      totalTokens: 1200,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 10,
    });
  });

  it('createTurnHandler maps stop reason to OTel convention', async () => {
    const { fake, bridge } = await startBridgeWithFake();
    await bridge!.createTurnHandler()(makeTurnData({ stopReason: 'stop' }));
    await bridge!.shutdown();

    const gen = fake.generations.find((g) => g.streaming)!;
    expect(gen.result?.stopReason).toBe('end_turn');
  });

  it('createTurnHandler emits one tool span per tool timing', async () => {
    const toolTimings: ToolTiming[] = [
      {
        toolCallId: 'tc-1',
        toolName: 'read_file',
        startedAt: new Date('2025-01-01T00:00:01Z'),
        completedAt: new Date('2025-01-01T00:00:02Z'),
        isError: false,
      },
      {
        toolCallId: 'tc-2',
        toolName: 'write_file',
        startedAt: new Date('2025-01-01T00:00:02Z'),
        completedAt: new Date('2025-01-01T00:00:03Z'),
        isError: false,
      },
    ];
    const { fake, bridge } = await startBridgeWithFake();
    await bridge!.createTurnHandler()(makeTurnData({ toolTimings }));
    await bridge!.shutdown();

    expect(fake.toolExecutions).toHaveLength(2);
    expect(fake.toolExecutions[0].toolName).toBe('read_file');
    expect(fake.toolExecutions[0].toolCallId).toBe('tc-1');
    expect(fake.toolExecutions[0].conversationId).toBe('conv-1');
    expect(fake.toolExecutions[0].requestModel).toBe('claude-sonnet-4-5');
    expect(fake.toolExecutions[0].requestProvider).toBe('anthropic');
    expect(fake.toolExecutions[0].ended).toBe(true);
    expect(fake.toolExecutions[0].callError).toBeUndefined();
    expect(fake.toolExecutions[1].toolName).toBe('write_file');
  });

  it('createTurnHandler sets callError for errored tools', async () => {
    const toolTimings: ToolTiming[] = [
      {
        toolCallId: 'tc-err',
        toolName: 'bash',
        startedAt: new Date(),
        completedAt: new Date(),
        isError: true,
      },
    ];
    const { fake, bridge } = await startBridgeWithFake();
    await bridge!.createTurnHandler()(makeTurnData({ toolTimings }));
    await bridge!.shutdown();

    expect(fake.toolExecutions[0].callError).toBeInstanceOf(Error);
    expect(fake.toolExecutions[0].completedAt).toBeUndefined();
  });

  it('createTurnHandler sets thinkingEnabled on streaming generation seed', async () => {
    const { fake, bridge } = await startBridgeWithFake();
    await bridge!.createTurnHandler()(makeTurnData({ thinkingEnabled: true }));
    await bridge!.shutdown();

    const gen = fake.generations.find((g) => g.streaming)!;
    expect(gen.start.thinkingEnabled).toBe(true);
  });
});
