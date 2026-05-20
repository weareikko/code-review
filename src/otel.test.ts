import type { Context } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { ReviewerError } from './errors.js';
import type { OtelRuntime } from './otel.js';
import {
  createDiagnosticContext,
  diagnosticChannels,
  traceDiagnostic,
  type DiagnosticContext,
} from './review.js';

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

  function createFakeRuntime() {
    const spans: RecordedSpan[] = [];
    const metricsRecorded: RecordedMetric[] = [];
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
      startSpan(name: string, _opts?: unknown, ctx?: unknown): RecordedSpan {
        // The bridge wires parent context through the real `@opentelemetry/api`
        // `trace.setSpan(context, span)` helper, so fetch the parent back out
        // with the real `trace.getSpan` rather than threading a symbol key.
        const parentRaw = ctx ? trace.getSpan(ctx as Context) : undefined;
        const parent =
          parentRaw && spans.includes(parentRaw as unknown as RecordedSpan)
            ? (parentRaw as unknown as RecordedSpan)
            : undefined;
        const span = makeSpan(name, parent);
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
    };
    const meterProvider = { getMeter: () => meter };

    const runtime = { tracerProvider, meterProvider, shutdown } as unknown as OtelRuntime;

    return { runtime, spans, metricsRecorded, shutdown };
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
});
