import type { Context } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { ReviewerError } from './errors.js';
import type { AgentLike } from './gitlab-review.js';
import type { OtelRuntime } from './otel.js';
import {
  createDiagnosticContext,
  diagnosticChannels,
  traceDiagnostic,
  type DiagnosticContext,
} from './review.js';

/** Builds a minimal but complete Config for inline test helpers that need it. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    project: 'mygroup/myrepo',
    mr: '7',
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
    ...overrides,
  };
}

function makeAgent(): AgentLike & { emit: (event: Record<string, unknown>) => Promise<void> } {
  type Listener = (event: Record<string, unknown>) => void | Promise<void>;
  const listeners: Listener[] = [];
  return {
    subscribe(listener: Listener): () => void {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    async prompt() {},
    async emit(event) {
      for (const l of listeners) await l(event);
    },
  };
}

describe('OpenTelemetry bridge', () => {
  interface RecordedAttribute {
    key: string;
    value: string | number | boolean;
  }
  interface RecordedSpan {
    name: string;
    attributes: RecordedAttribute[];
    status?: { code: number; message?: string };
    exceptions: Array<{ name?: string; message: string }>;
    ended: boolean;
    parent?: RecordedSpan;
  }
  interface RecordedMetric {
    name: string;
    value: number;
    attributes: Record<string, unknown>;
  }
  interface RecordedLog {
    severityNumber?: number;
    body: string;
    attributes: Record<string, unknown>;
  }

  function createFakeRuntime() {
    const spans: RecordedSpan[] = [];
    const metricsRecorded: RecordedMetric[] = [];
    const logsEmitted: RecordedLog[] = [];
    const shutdown = vi.fn(async () => undefined);

    const makeSpan = (name: string, parent: RecordedSpan | undefined): RecordedSpan => {
      const span: RecordedSpan = {
        name,
        attributes: [],
        exceptions: [],
        ended: false,
        parent,
      };
      spans.push(span);
      return span;
    };

    const tracer = {
      startSpan(
        name: string,
        opts?: { attributes?: Record<string, unknown> },
        ctx?: unknown,
      ): RecordedSpan {
        // The bridge wires parent context through the real `@opentelemetry/api`
        // `trace.setSpan(context, span)` helper, so fetch the parent back out
        // with the real `trace.getSpan` rather than threading a symbol key.
        const parentRaw = ctx ? trace.getSpan(ctx as Context) : undefined;
        const parent =
          parentRaw && spans.includes(parentRaw as unknown as RecordedSpan)
            ? (parentRaw as unknown as RecordedSpan)
            : undefined;
        const span = makeSpan(name, parent);
        // Seed initial attributes from the options so assertions on span.attributes
        // see attributes that were passed at span creation time (not only via setAttribute).
        if (opts?.attributes) {
          for (const [key, value] of Object.entries(opts.attributes)) {
            span.attributes.push({ key, value: value as string | number | boolean });
          }
        }
        return Object.assign(span, {
          setAttribute(key: string, value: string | number | boolean) {
            span.attributes.push({ key, value });
          },
          setStatus(status: { code: number; message?: string }) {
            span.status = status;
          },
          recordException(exception: { name?: string; message: string }) {
            span.exceptions.push(exception);
          },
          end() {
            span.ended = true;
          },
          // Implement the minimum SpanContext-ish surface so `trace.setSpan`
          // can store this span on a Context for later retrieval.
          spanContext() {
            return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 };
          },
        });
      },
    };
    const tracerProvider = { getTracer: () => tracer };

    const meter = {
      createHistogram(name: string) {
        return {
          record(value: number, attributes: Record<string, unknown> = {}) {
            metricsRecorded.push({ name, value, attributes });
          },
        };
      },
      createCounter(name: string) {
        return {
          add(value: number, attributes: Record<string, unknown> = {}) {
            metricsRecorded.push({ name, value, attributes });
          },
        };
      },
    };
    const meterProvider = { getMeter: () => meter };

    const fakeLogger = {
      emit(log: { severityNumber?: number; body?: unknown; attributes?: Record<string, unknown> }) {
        logsEmitted.push({
          severityNumber: log.severityNumber,
          body: String(log.body ?? ''),
          attributes: log.attributes ?? {},
        });
      },
    };
    const loggerProvider = { getLogger: () => fakeLogger };

    const runtime = {
      tracerProvider,
      meterProvider,
      loggerProvider,
      shutdown,
    } as unknown as OtelRuntime;

    return { runtime, spans, metricsRecorded, logsEmitted, shutdown };
  }

  async function runWithBridge(
    work: (ctx: DiagnosticContext) => Promise<void>,
    runId = 'run-otel',
  ): Promise<ReturnType<typeof createFakeRuntime>> {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });
    expect(bridge).not.toBeNull();

    const config: Config = {
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
    };

    const runContext = createDiagnosticContext('run', config, runId);
    try {
      await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
        await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async (ctx) => {
          await work(ctx);
        });
      });
    } catch {
      // Swallow — error-path tests assert on captured spans instead.
    } finally {
      await bridge?.shutdown();
    }
    return fake;
  }

  it('is false unless GITLAB_REVIEW_OTEL is explicitly opted in', async () => {
    const { isOtelEnabled } = await import('./otel.js');
    expect(isOtelEnabled({})).toBe(false);
    expect(isOtelEnabled({ GITLAB_REVIEW_OTEL: '0' })).toBe(false);
    expect(isOtelEnabled({ GITLAB_REVIEW_OTEL: 'yes' })).toBe(false);
    expect(isOtelEnabled({ GITLAB_REVIEW_OTEL: '1' })).toBe(true);
    expect(isOtelEnabled({ GITLAB_REVIEW_OTEL: 'true' })).toBe(true);
  });

  it('returns null when disabled without touching the runtime', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const result = await startOtelBridge({ runtime: fake.runtime, env: {} });
    expect(result).toBeNull();
    expect(fake.spans).toHaveLength(0);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('opens an invoke_workflow span per run and parents phase spans under it', async () => {
    const { spans } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });

    expect(spans.map((s) => s.name)).toEqual([
      'invoke_workflow gitlab-review',
      'invoke_agent gitlab-review',
    ]);
    const [root, reviewer] = spans;
    expect(reviewer.parent).toBe(root);
    expect(root.ended).toBe(true);
    expect(reviewer.ended).toBe(true);
  });

  it('stamps gen_ai.* attributes on reviewer.run from DiagnosticUsage', async () => {
    const { spans } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 1200, output: 340, cacheRead: 50, cacheWrite: 10, total: 1600 },
        cost: { input: 0.012, output: 0.034, cacheRead: 0.001, cacheWrite: 0.002, total: 0.049 },
      };
    });
    const reviewer = spans.find((s) => s.name === 'invoke_agent gitlab-review');
    const attrs = Object.fromEntries(reviewer!.attributes.map((a) => [a.key, a.value]));
    expect(attrs).toMatchObject({
      'gen_ai.conversation.id': 'run-otel',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
      'gen_ai.response.model': 'claude-sonnet-4-5',
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'gitlab-review',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 340,
      'gen_ai.usage.cache_read.input_tokens': 50,
      'gen_ai.usage.cache_creation.input_tokens': 10,
      'gen_ai.usage.cost.total_usd': 0.049,
    });
  });

  it('records gen_ai client metrics from DiagnosticUsage on the success path', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, total: 1540 },
        cost: { input: 0.012, output: 0.034, cacheRead: 0, cacheWrite: 0, total: 0.046 },
      };
    });

    const duration = metricsRecorded.find((m) => m.name === 'gen_ai.client.operation.duration');
    expect(duration).toBeDefined();
    expect(typeof duration!.value).toBe('number');
    expect(duration!.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
      'gen_ai.response.model': 'claude-sonnet-4-5',
    });
    expect(duration!.attributes).not.toHaveProperty('error.type');

    const tokens = metricsRecorded.filter((m) => m.name === 'gen_ai.client.token.usage');
    expect(tokens).toHaveLength(2);
    const byType = new Map(tokens.map((t) => [t.attributes['gen_ai.token.type'], t]));
    expect(byType.get('input')?.value).toBe(1200);
    expect(byType.get('output')?.value).toBe(340);
    expect(byType.get('input')?.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
    });
  });

  it('records exceptions and ERROR status on rejected phases', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });

    const config: Config = {
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
    };
    const ctx = createDiagnosticContext('reviewer.run', config, 'run-error');
    await expect(
      traceDiagnostic(diagnosticChannels.runReviewer, ctx, async () => {
        throw new ReviewerError('boom');
      }),
    ).rejects.toThrow('boom');
    await bridge?.shutdown();

    const reviewer = fake.spans.find((s) => s.name === 'invoke_agent gitlab-review');
    expect(reviewer?.exceptions).toEqual([
      expect.objectContaining({ name: 'ReviewerError', message: 'boom' }),
    ]);
    expect(reviewer?.status).toEqual({ code: 2, message: 'boom' });
    expect(reviewer?.ended).toBe(true);

    const duration = fake.metricsRecorded.find(
      (m) => m.name === 'gen_ai.client.operation.duration',
    );
    expect(duration?.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      // `error.type` prefers the typed-error `code` over the class name —
      // ReviewerError sets code='REVIEWER_ERROR'.
      'error.type': 'REVIEWER_ERROR',
    });
  });

  it('awaits runtime.shutdown when the bridge stops', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });
    await bridge?.shutdown();
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('propagates every gitlab_review.* result attribute when present on the context', async () => {
    const { spans } = await runWithBridge(async (ctx) => {
      ctx.generated = 7;
      ctx.newComments = 5;
      ctx.duplicateComments = 2;
      ctx.posted = 4;
      ctx.draftsCreated = 6;
      ctx.draftsPublished = 6;
    });
    const reviewer = spans.find((s) => s.name === 'invoke_agent gitlab-review');
    const attrs = Object.fromEntries(reviewer!.attributes.map((a) => [a.key, a.value]));
    // `durationMs` is stamped by `traceDiagnostic` from real elapsed time — we
    // only assert the branch fired, not its value.
    expect(typeof attrs['gitlab_review.duration_ms']).toBe('number');
    expect(attrs).toMatchObject({
      'gitlab_review.comments.generated': 7,
      'gitlab_review.comments.new': 5,
      'gitlab_review.comments.duplicate': 2,
      'gitlab_review.comments.posted': 4,
      'gitlab_review.drafts.created': 6,
      'gitlab_review.drafts.published': 6,
    });
  });

  // Regression test for the 0.1.7 crash: `loadDefaultRuntime` called
  // `new resources.Resource(...)` which throws under `@opentelemetry/resources`
  // v2. The rest of the suite injects a fake runtime and never touches the
  // real OTel bootstrap, so the bug shipped despite green tests. This test
  // exercises the production import + `NodeSDK` start/shutdown path against
  // the bundled OTel packages with all exporters disabled so no network I/O
  // is attempted.
  it('boots NodeSDK against the real @opentelemetry runtime without throwing', async () => {
    vi.stubEnv('OTEL_TRACES_EXPORTER', 'none');
    vi.stubEnv('OTEL_METRICS_EXPORTER', 'none');
    vi.stubEnv('OTEL_LOGS_EXPORTER', 'none');
    try {
      const { startOtelBridge } = await import('./otel.js');
      const bridge = await startOtelBridge({ env: { GITLAB_REVIEW_OTEL: '1' } });
      expect(bridge).not.toBeNull();
      await expect(bridge!.shutdown()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('records gen_ai.client.cost on the aggregate reviewer span', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });
    const cost = metricsRecorded.find((m) => m.name === 'gen_ai.client.cost');
    expect(cost).toBeDefined();
    expect(cost!.value).toBeCloseTo(0.03);
    expect(cost!.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.request.model': 'claude-sonnet-4-5',
    });
  });

  // ---------------------------------------------------------------------------
  // createAgentTelemetry — per-turn and per-tool spans / metrics
  // ---------------------------------------------------------------------------

  async function runWithAgentTelemetry(
    agentWork: (agent: ReturnType<typeof makeAgent>) => Promise<void>,
    runId = 'run-agent',
  ): Promise<ReturnType<typeof createFakeRuntime>> {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });

    const config: Config = {
      project: 'proj',
      mr: '1',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 't',
      gitlabAuthHeader: 'PRIVATE-TOKEN',
      model: 'anthropic/claude-haiku-4-5',
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
    };

    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async () => {
        const attach = bridge!.createAgentTelemetry(runId);
        expect(attach).toBeDefined();
        const agent = makeAgent();
        const detach = attach!(agent);
        await agentWork(agent);
        detach();
      });
    });
    await bridge!.shutdown();
    return fake;
  }

  it('createAgentTelemetry returns undefined when reviewer span is not yet open', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });
    expect(bridge!.createAgentTelemetry('nonexistent-run')).toBeUndefined();
    await bridge!.shutdown();
  });

  it('emits a gen_ai.agent.turn span per turn, parented to invoke_agent', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
    };
    const { spans } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'message_end', message: fakeMsg });
      await agent.emit({ type: 'turn_start', turnIndex: 2 });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const turnSpans = spans.filter((s) => s.name === 'gen_ai.agent.turn');
    expect(turnSpans).toHaveLength(2);

    const invokeAgent = spans.find((s) => s.name === 'invoke_agent gitlab-review');
    for (const ts of turnSpans) {
      expect(ts.parent).toBe(invokeAgent);
      expect(ts.ended).toBe(true);
    }

    const idx = Object.fromEntries(turnSpans[0].attributes.map((a) => [a.key, a.value]));
    expect(idx['gen_ai.conversation.id']).toBe('run-agent');
    expect(idx['gen_ai.agent.turn.index']).toBe(1);
  });

  it('stamps per-turn token usage and cost on turn spans', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: {
        input: 300,
        output: 80,
        cacheRead: 50,
        cacheWrite: 0,
        cost: { input: 0.003, output: 0.008, cacheRead: 0.0005, cacheWrite: 0, total: 0.0115 },
      },
    };
    const { spans } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const turn = spans.find((s) => s.name === 'gen_ai.agent.turn');
    const attrs = Object.fromEntries(turn!.attributes.map((a) => [a.key, a.value]));
    expect(attrs).toMatchObject({
      'gen_ai.usage.input_tokens': 300,
      'gen_ai.usage.output_tokens': 80,
      'gen_ai.usage.cache_read.input_tokens': 50,
      'gen_ai.usage.cost.total_usd': 0.0115,
      'gen_ai.response.model': 'claude-haiku-4-5',
      'gen_ai.response.stop_reason': 'end_turn',
    });
  });

  it('records per-turn token usage and cost metrics', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: {
        input: 400,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.004, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.014 },
      },
    };
    const { metricsRecorded } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const tokenMetrics = metricsRecorded.filter((m) => m.name === 'gen_ai.client.token.usage');
    // One per-turn input + output (plus aggregate from diagnosticChannel close)
    const perTurnInput = tokenMetrics.find(
      (m) => m.attributes['gen_ai.token.type'] === 'input' && m.value === 400,
    );
    const perTurnOutput = tokenMetrics.find(
      (m) => m.attributes['gen_ai.token.type'] === 'output' && m.value === 100,
    );
    expect(perTurnInput).toBeDefined();
    expect(perTurnOutput).toBeDefined();

    const costMetrics = metricsRecorded.filter((m) => m.name === 'gen_ai.client.cost');
    const perTurnCost = costMetrics.find((m) => Math.abs(m.value - 0.014) < 0.0001);
    expect(perTurnCost).toBeDefined();
    expect(perTurnCost!.attributes).toMatchObject({ 'gen_ai.request.model': 'claude-haiku-4-5' });
  });

  it('records TTFT metric when message_update fires before message_end', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    };
    const { metricsRecorded, spans } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'message_update', message: { role: 'assistant' } });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const ttft = metricsRecorded.find((m) => m.name === 'gen_ai.client.time_to_first_token');
    expect(ttft).toBeDefined();
    expect(typeof ttft!.value).toBe('number');
    expect(ttft!.value).toBeGreaterThanOrEqual(0);

    const turn = spans.find((s) => s.name === 'gen_ai.agent.turn');
    const attrs = Object.fromEntries(turn!.attributes.map((a) => [a.key, a.value]));
    expect(typeof attrs['gen_ai.client.time_to_first_token_s']).toBe('number');
  });

  it('does not record TTFT when no message_update fires', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    };
    const { metricsRecorded } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });
    expect(
      metricsRecorded.find((m) => m.name === 'gen_ai.client.time_to_first_token'),
    ).toBeUndefined();
  });

  it('emits execute_tool spans as children of the current turn span', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    };
    const { spans } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'tool_execution_start', toolName: 'Read', toolCallId: 'tc-1' });
      await agent.emit({ type: 'tool_execution_end', toolCallId: 'tc-1', isError: false });
      await agent.emit({ type: 'tool_execution_start', toolName: 'Grep', toolCallId: 'tc-2' });
      await agent.emit({ type: 'tool_execution_end', toolCallId: 'tc-2', isError: false });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const toolSpans = spans.filter((s) => s.name.startsWith('execute_tool '));
    expect(toolSpans).toHaveLength(2);
    expect(toolSpans.map((s) => s.name).toSorted()).toEqual([
      'execute_tool Grep',
      'execute_tool Read',
    ]);

    const turn = spans.find((s) => s.name === 'gen_ai.agent.turn');
    for (const ts of toolSpans) {
      expect(ts.parent).toBe(turn);
      expect(ts.ended).toBe(true);
    }

    const readAttrs = Object.fromEntries(
      toolSpans
        .find((s) => s.name === 'execute_tool Read')!
        .attributes.map((a) => [a.key, a.value]),
    );
    expect(readAttrs).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.id': 'tc-1',
    });
  });

  it('marks tool span with ERROR status when tool fails', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    };
    const { spans } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'tool_execution_start', toolName: 'Bash', toolCallId: 'tc-err' });
      await agent.emit({ type: 'tool_execution_end', toolCallId: 'tc-err', isError: true });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const bash = spans.find((s) => s.name === 'execute_tool Bash');
    expect(bash?.status?.code).toBe(2); // SpanStatusCode.ERROR = 2
    expect(bash?.ended).toBe(true);
  });

  it('flushes open turn and tool spans on agent_end', async () => {
    const { spans } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'tool_execution_start', toolName: 'Read', toolCallId: 'tc-x' });
      // Simulate abrupt end without tool_execution_end or message_end
      await agent.emit({ type: 'agent_end', messages: [] });
    });

    for (const span of spans) {
      expect(span.ended).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // OTel logs — review completion and per-comment records
  // ---------------------------------------------------------------------------

  it('emits a review completion log when the run phase closes', async () => {
    const { logsEmitted } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-haiku-4-5',
        tokens: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, total: 360 },
        cost: { input: 0.001, output: 0.002, cacheRead: 0.002, cacheWrite: 0.001, total: 0.006 },
      };
    });
    const completedLog = logsEmitted.find(
      (l) => l.attributes['event.name'] === 'gitlab_review.completed',
    );
    expect(completedLog).toBeDefined();
    expect(completedLog!.body).toMatch(/review completed: proj MR#1/);
    expect(completedLog!.attributes).toMatchObject({
      'event.name': 'gitlab_review.completed',
      'gitlab.project_id': 'proj',
      'gitlab.mr_iid': '1',
      'gen_ai.request.model': 'claude-haiku-4-5',
      'gen_ai.usage.cost.total_usd': 0.006,
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 50,
      'gen_ai.usage.cache_read.input_tokens': 200,
      'gen_ai.usage.cache_creation.input_tokens': 10,
    });
  });

  it('logComments emits one log record per comment with file/line/severity/is_duplicate', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });

    const config: Config = {
      project: 'acme/web',
      mr: '42',
      gitlabUrl: 'https://gitlab.acme.com',
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
    };
    const runContext = createDiagnosticContext('run', config, 'run-logs');
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      bridge!.logComments(
        [
          {
            comment: {
              file: 'src/auth.ts',
              line: 42,
              side: 'RIGHT',
              severity: 'critical',
              body: 'Use bcrypt.',
            },
            fingerprints: { primary: 'a', secondary: 'b' },
            duplicate: false,
            payload: {
              body: '',
              position: {
                position_type: 'text',
                base_sha: '',
                start_sha: '',
                head_sha: '',
                old_path: '',
                new_path: '',
              },
            },
          },
          {
            comment: {
              file: 'src/utils.ts',
              line: 7,
              side: 'RIGHT',
              severity: 'warn',
              body: 'Remove unused import.',
            },
            fingerprints: { primary: 'c', secondary: 'd' },
            duplicate: true,
            payload: {
              body: '',
              position: {
                position_type: 'text',
                base_sha: '',
                start_sha: '',
                head_sha: '',
                old_path: '',
                new_path: '',
              },
            },
          },
        ],
        'run-logs',
      );
    });
    await bridge!.shutdown();

    const commentLogs = fake.logsEmitted.filter(
      (l) => l.attributes['event.name'] === 'gitlab_review.comment',
    );
    expect(commentLogs).toHaveLength(2);

    const [auth, utils] = commentLogs;
    expect(auth.body).toContain('[critical] src/auth.ts:42');
    expect(auth.attributes).toMatchObject({
      'gitlab.project_id': 'acme/web',
      'gitlab.mr_iid': '42',
      'gitlab_review.run_id': 'run-logs',
      'gitlab_review.comment.file': 'src/auth.ts',
      'gitlab_review.comment.line': 42,
      'gitlab_review.comment.severity': 'critical',
      'gitlab_review.comment.is_duplicate': false,
    });
    expect(utils.attributes['gitlab_review.comment.is_duplicate']).toBe(true);
  });

  it('propagates CI_* env vars as gitlab.* attributes on spans, metrics, and logs', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: {
        GITLAB_REVIEW_OTEL: '1',
        CI_PROJECT_PATH: 'my-group/my-project',
        CI_PROJECT_NAMESPACE: 'my-group',
        CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main',
        CI_PIPELINE_SOURCE: 'merge_request_event',
      },
    });

    const config: Config = {
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
    };
    const runContext = createDiagnosticContext('run', config, 'run-ci');
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, 'run-ci');
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async (ctx) => {
        ctx.usage = {
          model: 'anthropic/claude-sonnet-4-5',
          tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        };
      });
    });
    await bridge!.shutdown();

    const expectedCiAttrs = {
      'gitlab.project_path': 'my-group/my-project',
      'gitlab.project_namespace': 'my-group',
      'gitlab.mr_target_branch': 'main',
      'gitlab.pipeline_source': 'merge_request_event',
    };

    // All phase spans carry CI attrs.
    for (const span of fake.spans) {
      const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
      expect(attrs).toMatchObject(expectedCiAttrs);
    }

    // gen_ai.* metrics carry all CI attrs (they spread ciAttrs wholesale).
    const genAiMetrics = fake.metricsRecorded.filter((m) => m.name.startsWith('gen_ai.'));
    for (const metric of genAiMetrics) {
      expect(metric.attributes).toMatchObject(expectedCiAttrs);
    }
    // Review-level metrics carry at least gitlab.project_path (the primary
    // grouping dimension); other CI attrs are omitted per the metric spec.
    const reviewMetrics = fake.metricsRecorded.filter((m) => m.name.startsWith('gitlab_review_'));
    for (const metric of reviewMetrics) {
      expect(metric.attributes['gitlab.project_path']).toBe('my-group/my-project');
    }

    // Review completion log carries CI attrs.
    const completedLog = fake.logsEmitted.find(
      (l) => l.attributes['event.name'] === 'gitlab_review.completed',
    );
    expect(completedLog?.attributes).toMatchObject(expectedCiAttrs);
  });

  it('omits gitlab.project_path and siblings when CI vars are absent', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });
    // runWithBridge passes env: { GITLAB_REVIEW_OTEL: '1' } with no CI_* vars.
    const cost = metricsRecorded.find((m) => m.name === 'gen_ai.client.cost');
    expect(cost?.attributes).not.toHaveProperty('gitlab.project_path');
    expect(cost?.attributes).not.toHaveProperty('gitlab.project_namespace');
    expect(cost?.attributes).not.toHaveProperty('gitlab.mr_target_branch');
    expect(cost?.attributes).not.toHaveProperty('gitlab.pipeline_source');
  });

  it('logComments truncates comment body at 500 chars', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });
    const config: Config = {
      project: 'p',
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
    };
    const runContext = createDiagnosticContext('run', config, 'run-trunc');
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      bridge!.logComments(
        [
          {
            comment: {
              file: 'a.ts',
              line: 1,
              side: 'RIGHT',
              severity: 'info',
              body: 'x'.repeat(600),
            },
            fingerprints: { primary: 'e', secondary: 'f' },
            duplicate: false,
            payload: {
              body: '',
              position: {
                position_type: 'text',
                base_sha: '',
                start_sha: '',
                head_sha: '',
                old_path: '',
                new_path: '',
              },
            },
          },
        ],
        'run-trunc',
      );
    });
    await bridge!.shutdown();

    const log = fake.logsEmitted.find(
      (l) => l.attributes['event.name'] === 'gitlab_review.comment',
    );
    // The log body includes the prefix "[info] a.ts:1 — " plus the truncated body.
    expect(log!.body).toContain('…');
    // Total body should not exceed ~520 chars (prefix + 500 content chars + ellipsis)
    expect(log!.body.length).toBeLessThan(520);
  });

  // ---------------------------------------------------------------------------
  // Review-level OTel metrics (gitlab_review_* instruments)
  // ---------------------------------------------------------------------------

  it('emits gitlab_review_run_duration_seconds and gitlab_review_total_cost_usd on success', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runId = 'run-review-metrics';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async (ctx) => {
        ctx.usage = {
          model: 'anthropic/claude-sonnet-4-5',
          tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200 },
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        };
      });
    });
    await bridge!.shutdown();

    const runDuration = fake.metricsRecorded.find(
      (m) => m.name === 'gitlab_review_run_duration_seconds',
    );
    expect(runDuration).toBeDefined();
    expect(typeof runDuration!.value).toBe('number');
    expect(runDuration!.value).toBeGreaterThanOrEqual(0);
    expect(runDuration!.attributes).toMatchObject({
      'gitlab_review.dry_run': false,
      'gitlab_review.status': 'success',
    });

    const totalCost = fake.metricsRecorded.find((m) => m.name === 'gitlab_review_total_cost_usd');
    expect(totalCost).toBeDefined();
    expect(totalCost!.value).toBeCloseTo(0.03);
    expect(totalCost!.attributes).toMatchObject({
      'gitlab_review.dry_run': false,
      'gitlab_review.status': 'success',
    });
  });

  it('emits gitlab_review_comments_total and gitlab_review_drafts_published_total', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runId = 'run-counters';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async (ctx) => {
      // Simulate the post_comments phase populating draftsPublished.
      const postContext = createDiagnosticContext('gitlab.post_comments', config, runId);
      await traceDiagnostic(diagnosticChannels.postComments, postContext, async (pCtx) => {
        pCtx.draftsPublished = 4;
      });
      // Root context carries the comments-posted count.
      ctx.posted = 6;
    });
    await bridge!.shutdown();

    const comments = fake.metricsRecorded.find((m) => m.name === 'gitlab_review_comments_total');
    expect(comments).toBeDefined();
    expect(comments!.value).toBe(6);
    expect(comments!.attributes).toMatchObject({ 'gitlab_review.dry_run': false });

    const drafts = fake.metricsRecorded.find(
      (m) => m.name === 'gitlab_review_drafts_published_total',
    );
    expect(drafts).toBeDefined();
    expect(drafts!.value).toBe(4);
    expect(drafts!.attributes).toMatchObject({ 'gitlab_review.dry_run': false });
  });

  it('emits gitlab_review_phase_duration_seconds for every measured phase', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });

    const phaseDurations = metricsRecorded.filter(
      (m) => m.name === 'gitlab_review_phase_duration_seconds',
    );
    // runWithBridge opens `run` and `reviewer.run` phases — both must emit.
    expect(phaseDurations.length).toBeGreaterThanOrEqual(2);

    const reviewerPhase = phaseDurations.find(
      (m) => m.attributes['gitlab_review.phase'] === 'reviewer.run',
    );
    expect(reviewerPhase).toBeDefined();
    expect(typeof reviewerPhase!.value).toBe('number');
    expect(reviewerPhase!.value).toBeGreaterThanOrEqual(0);
    expect(reviewerPhase!.attributes['gitlab_review.status']).toBe('success');

    const runPhase = phaseDurations.find((m) => m.attributes['gitlab_review.phase'] === 'run');
    expect(runPhase).toBeDefined();
    expect(runPhase!.attributes['gitlab_review.status']).toBe('success');
  });

  it('sets gitlab_review.status=error on run-level metrics when the run throws', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runId = 'run-error-status';
    const runContext = createDiagnosticContext('run', config, runId);
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw new Error('something broke');
      }),
    ).rejects.toThrow('something broke');
    await bridge!.shutdown();

    const runDuration = fake.metricsRecorded.find(
      (m) => m.name === 'gitlab_review_run_duration_seconds',
    );
    expect(runDuration).toBeDefined();
    expect(runDuration!.attributes['gitlab_review.status']).toBe('error');

    const phaseDuration = fake.metricsRecorded.find(
      (m) =>
        m.name === 'gitlab_review_phase_duration_seconds' &&
        m.attributes['gitlab_review.phase'] === 'run',
    );
    expect(phaseDuration!.attributes['gitlab_review.status']).toBe('error');
  });

  it('sets gitlab_review.status=timeout when the run is aborted', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { GITLAB_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runId = 'run-timeout-status';
    const runContext = createDiagnosticContext('run', config, runId);
    const abortError = Object.assign(new Error('operation aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw abortError;
      }),
    ).rejects.toThrow('operation aborted');
    await bridge!.shutdown();

    const runDuration = fake.metricsRecorded.find(
      (m) => m.name === 'gitlab_review_run_duration_seconds',
    );
    expect(runDuration).toBeDefined();
    expect(runDuration!.attributes['gitlab_review.status']).toBe('timeout');
  });

  it('omits gitlab_review_total_cost_usd when no usage is recorded', async () => {
    const { metricsRecorded } = await runWithBridge(async () => {
      // No ctx.usage set — reviewer phase produces no cost data.
    });

    expect(metricsRecorded.find((m) => m.name === 'gitlab_review_total_cost_usd')).toBeUndefined();
  });

  it('carries gitlab.pipeline_source on gitlab_review_run_duration_seconds when CI var is set', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: {
        GITLAB_REVIEW_OTEL: '1',
        CI_PROJECT_PATH: 'corp/svc',
        CI_PIPELINE_SOURCE: 'merge_request_event',
      },
    });

    const config = makeConfig();
    const runId = 'run-pipeline-source';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {});
    await bridge!.shutdown();

    const runDuration = fake.metricsRecorded.find(
      (m) => m.name === 'gitlab_review_run_duration_seconds',
    );
    expect(runDuration!.attributes).toMatchObject({
      'gitlab.project_path': 'corp/svc',
      'gitlab.pipeline_source': 'merge_request_event',
    });
  });
});
