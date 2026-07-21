import type { Context } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { GitLabApiError, ReviewerError } from './errors.js';
import type { AgentLike } from './gitlab-review.js';
import type { OtelRuntime } from './otel.js';
import { isContentCaptureEnabled } from './otel.js';
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
    reviewDepth: 'single',
    apiKey: 'k',
    reviewFile: 'code-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: '/tmp',
    skills: [],
    refreshGitSkills: false,
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
    context?: unknown;
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
      emit(log: {
        severityNumber?: number;
        body?: unknown;
        attributes?: Record<string, unknown>;
        context?: unknown;
      }) {
        logsEmitted.push({
          severityNumber: log.severityNumber,
          body: String(log.body ?? ''),
          attributes: log.attributes ?? {},
          context: log.context,
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
      env: { CODE_REVIEW_OTEL: '1' },
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
      reviewDepth: 'single',
      apiKey: 'k',
      reviewFile: 'code-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
      postSummary: false,
      forceReview: false,
      verbose: false,
      cwd: '/tmp',
      skills: [],
      refreshGitSkills: false,
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

  it('is false unless CODE_REVIEW_OTEL is explicitly opted in', async () => {
    const { isOtelEnabled } = await import('./otel.js');
    expect(isOtelEnabled({})).toBe(false);
    expect(isOtelEnabled({ CODE_REVIEW_OTEL: '0' })).toBe(false);
    expect(isOtelEnabled({ CODE_REVIEW_OTEL: 'yes' })).toBe(false);
    expect(isOtelEnabled({ CODE_REVIEW_OTEL: '1' })).toBe(true);
    expect(isOtelEnabled({ CODE_REVIEW_OTEL: 'true' })).toBe(true);
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
      'invoke_workflow code-review',
      'invoke_agent code-review',
    ]);
    const [root, reviewer] = spans;
    expect(reviewer.parent).toBe(root);
    expect(root.ended).toBe(true);
    expect(reviewer.ended).toBe(true);
  });

  it('stamps code_review.run_id on the root invoke_workflow span for 3-pillar correlation', async () => {
    const { spans } = await runWithBridge(async () => {}, 'run-correlation-id');
    const root = spans.find((s) => s.name === 'invoke_workflow code-review');
    const attrs = Object.fromEntries(root!.attributes.map((a) => [a.key, a.value]));
    // run_id on the root span is what lets a trace be joined to its metric
    // series (via the status/project labels) and its log stream (via run_id).
    expect(attrs['code_review.run_id']).toBe('run-correlation-id');
    expect(attrs['gen_ai.conversation.id']).toBe('run-correlation-id');
  });

  it('stamps gen_ai.* attributes on reviewer.run from DiagnosticUsage', async () => {
    const { spans } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 1200, output: 340, cacheRead: 50, cacheWrite: 10, total: 1600 },
        cost: { input: 0.012, output: 0.034, cacheRead: 0.001, cacheWrite: 0.002, total: 0.049 },
      };
    });
    const reviewer = spans.find((s) => s.name === 'invoke_agent code-review');
    const attrs = Object.fromEntries(reviewer!.attributes.map((a) => [a.key, a.value]));
    expect(attrs).toMatchObject({
      'gen_ai.conversation.id': 'run-otel',
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
      'gen_ai.response.model': 'claude-sonnet-4-5',
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'code-review',
      // Total input = non-cached (1200) + cached (50) — Sentry AI monitoring model.
      'gen_ai.usage.input_tokens': 1250,
      'gen_ai.usage.input_tokens.cached': 50,
      'gen_ai.usage.output_tokens': 340,
      'gen_ai.usage.cache_read.input_tokens': 50,
      'gen_ai.usage.cache_creation.input_tokens': 10,
      'gen_ai.usage.cost.total_usd': 0.049,
    });
  });

  it('records gen_ai.client.operation.duration from reviewer phase context', async () => {
    // gen_ai.client.operation.duration is emitted by recordGenAiMetrics at
    // reviewer-phase close. Token usage and cost are emitted per-turn by
    // buildAgentSubscriber — confirmed absent here (no agent events fired).
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
      'service.name': '@weareikko/code-review',
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
    });
    // gen_ai.response.model belongs on spans (traces), not on metric data points.
    expect(duration!.attributes).not.toHaveProperty('gen_ai.response.model');
    expect(duration!.attributes).not.toHaveProperty('error.type');

    // No token or cost metrics from phase-close — those are per-turn only.
    expect(metricsRecorded.filter((m) => m.name === 'gen_ai.client.token.usage')).toHaveLength(0);
    expect(metricsRecorded.filter((m) => m.name === 'gen_ai.client.cost')).toHaveLength(0);
  });

  it('records exceptions and ERROR status on rejected phases', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
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
      reviewDepth: 'single',
      apiKey: 'k',
      reviewFile: 'code-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
      postSummary: false,
      forceReview: false,
      verbose: false,
      cwd: '/tmp',
      skills: [],
      refreshGitSkills: false,
    };
    const ctx = createDiagnosticContext('reviewer.run', config, 'run-error');
    await expect(
      traceDiagnostic(diagnosticChannels.runReviewer, ctx, async () => {
        throw new ReviewerError('boom');
      }),
    ).rejects.toThrow('boom');
    await bridge?.shutdown();

    const reviewer = fake.spans.find((s) => s.name === 'invoke_agent code-review');
    expect(reviewer?.exceptions).toEqual([
      expect.objectContaining({ name: 'ReviewerError', message: 'boom' }),
    ]);
    expect(reviewer?.status).toEqual({ code: 2, message: 'boom' });
    expect(reviewer?.ended).toBe(true);

    const duration = fake.metricsRecorded.find(
      (m) => m.name === 'gen_ai.client.operation.duration',
    );
    expect(duration?.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.system': 'anthropic',
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
      env: { CODE_REVIEW_OTEL: '1' },
    });
    await bridge?.shutdown();
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('propagates every code_review.* result attribute when present on the context', async () => {
    const { spans } = await runWithBridge(async (ctx) => {
      ctx.generated = 7;
      ctx.newComments = 5;
      ctx.duplicateComments = 2;
      ctx.posted = 4;
      ctx.draftsCreated = 6;
      ctx.draftsPublished = 6;
      ctx.warnings = 1;
      ctx.draftsAbandoned = 2;
      ctx.draftsDeletedPrePublish = 3;
      ctx.draftsPublishFailed = 1;
    });
    const reviewer = spans.find((s) => s.name === 'invoke_agent code-review');
    const attrs = Object.fromEntries(reviewer!.attributes.map((a) => [a.key, a.value]));
    // `durationMs` is stamped by `traceDiagnostic` from real elapsed time — we
    // only assert the branch fired, not its value.
    expect(typeof attrs['code_review.duration_ms']).toBe('number');
    expect(attrs).toMatchObject({
      'code_review.comments.generated': 7,
      'code_review.comments.new': 5,
      'code_review.comments.duplicate': 2,
      'code_review.comments.posted': 4,
      'code_review.drafts.created': 6,
      'code_review.drafts.published': 6,
      'code_review.warnings': 1,
      'code_review.drafts.abandoned': 2,
      'code_review.drafts.deleted_pre_publish': 3,
      'code_review.drafts.publish_failed': 1,
    });
  });

  it('stamps HTTP semantic-convention attributes on GitLab API spans', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runId = 'run-http-attrs';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const mrCtx = createDiagnosticContext('scm.get_merge_request', config, runId);
      await traceDiagnostic(diagnosticChannels.getMergeRequest, mrCtx, async (ctx) => {
        ctx.httpRequestMethod = 'GET';
        ctx.httpUrl =
          'https://gitlab.example.com/api/v4/projects/mygroup%2Fmyrepo/merge_requests/7';
        ctx.httpStatusCode = 200;
        ctx.httpResponseBodySize = 1234;
        ctx.serverAddress = 'gitlab.example.com';
      });
    });
    await bridge!.shutdown();

    const span = fake.spans.find((s) => s.name === 'code-review.scm.get_merge_request');
    expect(span).toBeDefined();
    const attrs = Object.fromEntries(span!.attributes.map((a) => [a.key, a.value]));
    expect(attrs).toMatchObject({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'http.response.body.size': 1234,
      'url.full': 'https://gitlab.example.com/api/v4/projects/mygroup%2Fmyrepo/merge_requests/7',
      'server.address': 'gitlab.example.com',
    });
  });

  it('opens a fresh span for a phase that runs twice per run (scm.get_discussions)', async () => {
    // get_discussions is fetched before and after the review; the second
    // occurrence must get its own span (and its own HTTP attributes), not be
    // dropped because the first (now-closed) entry still sits in the phase map.
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runId = 'run-discussions-twice';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const first = createDiagnosticContext('scm.get_discussions', config, runId);
      await traceDiagnostic(diagnosticChannels.getDiscussions, first, async (ctx) => {
        ctx.httpStatusCode = 200;
      });
      const second = createDiagnosticContext('scm.get_discussions', config, runId);
      await traceDiagnostic(diagnosticChannels.getDiscussions, second, async (ctx) => {
        ctx.httpStatusCode = 404;
      });
    });
    await bridge!.shutdown();

    const spans = fake.spans.filter((s) => s.name === 'code-review.scm.get_discussions');
    expect(spans).toHaveLength(2);
    const statuses = spans
      .map((s) => Object.fromEntries(s.attributes.map((a) => [a.key, a.value])))
      .map((attrs) => attrs['http.response.status_code']);
    expect(statuses).toEqual([200, 404]);
  });

  it('stamps diff size attributes on the git.get_merge_diff span', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runId = 'run-diff-size';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const diffCtx = createDiagnosticContext('git.get_merge_diff', config, runId);
      await traceDiagnostic(diagnosticChannels.getMergeDiff, diffCtx, async (ctx) => {
        ctx.diffFilesChanged = 3;
        ctx.diffLinesAdded = 42;
        ctx.diffLinesRemoved = 7;
      });
    });
    await bridge!.shutdown();

    const span = fake.spans.find((s) => s.name === 'code-review.git.get_merge_diff');
    expect(span).toBeDefined();
    const attrs = Object.fromEntries(span!.attributes.map((a) => [a.key, a.value]));
    expect(attrs).toMatchObject({
      'diff.files_changed': 3,
      'diff.lines_added': 42,
      'diff.lines_removed': 7,
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
      const bridge = await startOtelBridge({ env: { CODE_REVIEW_OTEL: '1' } });
      expect(bridge).not.toBeNull();
      await expect(bridge!.shutdown()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not emit gen_ai.client.cost from phase close alone (prevents double-count)', async () => {
    // Regression test for Gap 1: cost was previously emitted from BOTH
    // recordGenAiMetrics (phase-close) and buildAgentSubscriber (per-turn),
    // creating two Prometheus series that differed only by gen_ai_system and
    // summed to 2× the real cost in Grafana. Now only buildAgentSubscriber emits
    // cost. Confirm the phase-close path emits zero cost metrics.
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });
    const costMetrics = metricsRecorded.filter((m) => m.name === 'gen_ai.client.cost');
    expect(costMetrics).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // createAgentTelemetry — per-turn and per-tool spans / metrics
  // ---------------------------------------------------------------------------

  async function runWithAgentTelemetry(
    agentWork: (agent: ReturnType<typeof makeAgent>) => Promise<void>,
    runId = 'run-agent',
    dryRun = false,
  ): Promise<ReturnType<typeof createFakeRuntime>> {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
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
      reviewDepth: 'single',
      apiKey: 'k',
      reviewFile: 'code-review.md',
      output: 'review-comments.json',
      dryRun,
      noPost: false,
      postSummary: false,
      forceReview: false,
      verbose: false,
      cwd: '/tmp',
      skills: [],
      refreshGitSkills: false,
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
      env: { CODE_REVIEW_OTEL: '1' },
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

    const invokeAgent = spans.find((s) => s.name === 'invoke_agent code-review');
    for (const ts of turnSpans) {
      expect(ts.parent).toBe(invokeAgent);
      expect(ts.ended).toBe(true);
    }

    const idx = Object.fromEntries(turnSpans[0].attributes.map((a) => [a.key, a.value]));
    expect(idx['gen_ai.conversation.id']).toBe('run-agent');
    expect(idx['gen_ai.agent.turn.index']).toBe(1);
    expect(idx['gen_ai.agent.name']).toBe('code-review');
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
      'gen_ai.system': 'anthropic',
      // Total input = non-cached (300) + cached (50) — Sentry AI monitoring model.
      'gen_ai.usage.input_tokens': 350,
      'gen_ai.usage.input_tokens.cached': 50,
      'gen_ai.usage.output_tokens': 80,
      'gen_ai.usage.cache_read.input_tokens': 50,
      'gen_ai.usage.cost.total_usd': 0.0115,
      'gen_ai.response.model': 'claude-haiku-4-5',
      'gen_ai.response.stop_reason': 'end_turn',
      'gen_ai.agent.name': 'code-review',
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
    // Per-turn token metrics (sole source — phase-close no longer emits tokens).
    const perTurnInput = tokenMetrics.find(
      (m) => m.attributes['gen_ai.token.type'] === 'input' && m.value === 400,
    );
    const perTurnOutput = tokenMetrics.find(
      (m) => m.attributes['gen_ai.token.type'] === 'output' && m.value === 100,
    );
    expect(perTurnInput).toBeDefined();
    expect(perTurnOutput).toBeDefined();

    const costMetrics = metricsRecorded.filter((m) => m.name === 'gen_ai.client.cost');
    const costByType = new Map(costMetrics.map((m) => [m.attributes['gen_ai.token.type'], m]));
    // GAP 1 fix: cost is broken down by token type, no single total observation.
    expect(costByType.get('input')?.value).toBeCloseTo(0.004);
    expect(costByType.get('output')?.value).toBeCloseTo(0.01);
    expect(costByType.get('cache_read')).toBeUndefined(); // zero — skipped
    expect(costByType.get('cache_creation')).toBeUndefined(); // zero — skipped
    for (const metric of costMetrics) {
      expect(metric.attributes).toMatchObject({
        'service.name': '@weareikko/code-review',
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-haiku-4-5',
      });
      // gen_ai.response.model is span-only, not in metric labels (GAP 3 fix).
      expect(metric.attributes).not.toHaveProperty('gen_ai.response.model');
    }
  });

  it('records cache_read and cache_creation token metrics per turn (Gap 2 fix)', async () => {
    // Regression test for Gap 2: cache_read and cache_creation token counts were
    // previously absent from gen_ai_client_token_usage_sum even though they
    // dominate cache-heavy workloads (cache_write ~86% of cost in practice).
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-sonnet-4-5',
      stopReason: 'end_turn',
      usage: {
        input: 10,
        output: 302,
        cacheRead: 11334,
        cacheWrite: 13242,
        cost: {
          input: 0.00003,
          output: 0.00453,
          cacheRead: 0.0034,
          cacheWrite: 0.049658,
          total: 0.0576177,
        },
      },
    };
    const { metricsRecorded } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const tokenMetrics = metricsRecorded.filter((m) => m.name === 'gen_ai.client.token.usage');
    const byType = new Map(tokenMetrics.map((t) => [t.attributes['gen_ai.token.type'], t]));

    expect(byType.get('input')?.value).toBe(10);
    expect(byType.get('output')?.value).toBe(302);
    expect(byType.get('cache_read')?.value).toBe(11334);
    expect(byType.get('cache_creation')?.value).toBe(13242);

    // All four token metrics share a consistent label set (gen_ai.system present).
    for (const metric of tokenMetrics) {
      expect(metric.attributes).toMatchObject({
        'service.name': '@weareikko/code-review',
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-sonnet-4-5',
      });
    }

    // GAP 1 fix: cost is also broken down by token type.
    const costMetrics = metricsRecorded.filter((m) => m.name === 'gen_ai.client.cost');
    const costByType = new Map(costMetrics.map((m) => [m.attributes['gen_ai.token.type'], m]));
    expect(costByType.get('input')?.value).toBeCloseTo(0.00003);
    expect(costByType.get('output')?.value).toBeCloseTo(0.00453);
    expect(costByType.get('cache_read')?.value).toBeCloseTo(0.0034);
    expect(costByType.get('cache_creation')?.value).toBeCloseTo(0.049658);
  });

  it('tags per-turn gen_ai metrics with code_review.dry_run from the run context', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: {
        input: 50,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
    };
    const { metricsRecorded } = await runWithAgentTelemetry(
      async (agent) => {
        await agent.emit({ type: 'turn_start', turnIndex: 1 });
        await agent.emit({ type: 'message_end', message: fakeMsg });
      },
      'run-dry',
      true,
    );

    // Every per-turn metric must carry the dry_run label so dry-run LLM spend can
    // be excluded from the GenAI panels, matching the review-level metrics.
    const cost = metricsRecorded.find((m) => m.name === 'gen_ai.client.cost');
    expect(cost!.attributes['code_review.dry_run']).toBe(true);
    const tokens = metricsRecorded.find((m) => m.name === 'gen_ai.client.token.usage');
    expect(tokens!.attributes['code_review.dry_run']).toBe(true);
  });

  it('derives gen_ai.system from configuredModel when msg.model has no provider prefix', async () => {
    // The Anthropic SDK sometimes returns bare model IDs ('claude-haiku-4-5')
    // without a provider prefix. buildAgentSubscriber must fall back to the
    // configured model string to populate gen_ai.system so all per-turn metrics
    // have a consistent, complete label set. runWithAgentTelemetry uses
    // config.model = 'anthropic/claude-haiku-4-5' as the configured model.
    const fakeMsg = {
      role: 'assistant',
      model: 'claude-haiku-4-5', // No 'anthropic/' prefix — simulates SDK behaviour
      stopReason: 'end_turn',
      usage: {
        input: 50,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
    };
    const { metricsRecorded } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const costMetric = metricsRecorded.find((m) => m.name === 'gen_ai.client.cost');
    expect(costMetric).toBeDefined();
    // gen_ai.system must be populated from configuredModel even though msg.model
    // had no slash.
    expect(costMetric!.attributes['gen_ai.system']).toBe('anthropic');
    expect(costMetric!.attributes['gen_ai.request.model']).toBe('claude-haiku-4-5');

    const tokenInput = metricsRecorded.find(
      (m) =>
        m.name === 'gen_ai.client.token.usage' && m.attributes['gen_ai.token.type'] === 'input',
    );
    expect(tokenInput!.attributes['gen_ai.system']).toBe('anthropic');
  });

  it('emits gen_ai.client.cost exactly once when reviewer phase and agent both fire', async () => {
    // Full regression test for Gap 1: when both ctx.usage (phase result) and
    // agent message_end (per-turn events) carry cost data, cost must appear
    // exactly once in Prometheus — not twice as two series differing by
    // gen_ai_system that sum to 2× in a Grafana sum() query.
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: {
        input: 100,
        output: 30,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.001, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.004 },
      },
    };
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig({ model: 'anthropic/claude-haiku-4-5' });
    const runId = 'run-no-double-cost';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async (ctx) => {
        const attach = bridge!.createAgentTelemetry(runId);
        expect(attach).toBeDefined();
        const agent = makeAgent();
        const detach = attach!(agent);
        await agent.emit({ type: 'turn_start', turnIndex: 1 });
        await agent.emit({ type: 'message_end', message: fakeMsg });
        detach();
        // Simulate the real production path where ctx.usage is also populated
        // from the runReview result alongside the live agent events.
        ctx.usage = {
          model: 'anthropic/claude-haiku-4-5',
          tokens: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, total: 130 },
          cost: { input: 0.001, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.004 },
        };
      });
    });
    await bridge!.shutdown();

    const costMetrics = fake.metricsRecorded.filter((m) => m.name === 'gen_ai.client.cost');
    // Exactly two cost metrics (input + output by type) — no double-count from phase-close.
    expect(costMetrics).toHaveLength(2);
    const costByType = new Map(costMetrics.map((m) => [m.attributes['gen_ai.token.type'], m]));
    expect(costByType.get('input')?.value).toBeCloseTo(0.001);
    expect(costByType.get('output')?.value).toBeCloseTo(0.003);
    for (const m of costMetrics) {
      expect(m.attributes['gen_ai.system']).toBe('anthropic');
    }
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

  it('stamps process.exit_code on failed tool spans without content capture', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    };
    const { spans } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({
        type: 'tool_execution_start',
        toolName: 'Bash',
        toolCallId: 'tc-exit',
        args: { command: 'grep -r foo .' },
      });
      await agent.emit({
        type: 'tool_execution_end',
        toolCallId: 'tc-exit',
        isError: true,
        result: { code: 2, stderr: 'grep: invalid pattern' },
      });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const bash = spans.find((s) => s.name === 'execute_tool Bash');
    const attrs = Object.fromEntries(bash!.attributes.map((a) => [a.key, a.value]));
    // exit code is a safe numeric value — attached even without content capture.
    expect(attrs['process.exit_code']).toBe(2);
    // stderr and command are content — withheld unless capture is enabled.
    expect(attrs['tool.stderr']).toBeUndefined();
    expect(attrs['tool.command']).toBeUndefined();
  });

  it('attaches tool.stderr and tool.command to failed tool spans when captureContent=true', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
      captureContent: true,
    });

    const config = makeConfig({ model: 'anthropic/claude-haiku-4-5' });
    const runId = 'run-tool-error-content';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async () => {
        const attach = bridge!.createAgentTelemetry(runId);
        const agent = makeAgent();
        const detach = attach!(agent);
        await agent.emit({ type: 'turn_start', turnIndex: 1 });
        await agent.emit({
          type: 'tool_execution_start',
          toolName: 'Bash',
          toolCallId: 'tc-err-content',
          args: { command: 'grep -r foo .' },
        });
        await agent.emit({
          type: 'tool_execution_end',
          toolCallId: 'tc-err-content',
          isError: true,
          result: { code: 2, stderr: 'grep: invalid pattern' },
        });
        await agent.emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'anthropic/claude-haiku-4-5',
            stopReason: 'end_turn',
            content: [],
            usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
          },
        });
        detach();
      });
    });
    await bridge!.shutdown();

    const bash = fake.spans.find((s) => s.name === 'execute_tool Bash');
    const attrs = Object.fromEntries(bash!.attributes.map((a) => [a.key, a.value]));
    expect(attrs['process.exit_code']).toBe(2);
    expect(attrs['tool.stderr']).toBe('grep: invalid pattern');
    expect(attrs['tool.command']).toBe('grep -r foo .');
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
      (l) => l.attributes['event.name'] === 'code_review.completed',
    );
    expect(completedLog).toBeDefined();
    expect(completedLog!.body).toMatch(/review completed: proj MR#1/);
    expect(completedLog!.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'event.name': 'code_review.completed',
      'vcs.repository.id': 'proj',
      'vcs.change.id': '1',
      'gen_ai.request.model': 'claude-haiku-4-5',
      'gen_ai.usage.cost.total_usd': 0.006,
      // Total input = non-cached (100) + cached (200) — Sentry AI monitoring model.
      'gen_ai.usage.input_tokens': 300,
      'gen_ai.usage.input_tokens.cached': 200,
      'gen_ai.usage.output_tokens': 50,
      'gen_ai.usage.cache_read.input_tokens': 200,
      'gen_ai.usage.cache_creation.input_tokens': 10,
    });
  });

  it('emits a review.started log when the run phase opens, before completion', async () => {
    const { logsEmitted } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });

    const startedIdx = logsEmitted.findIndex(
      (l) => l.attributes['event.name'] === 'code_review.started',
    );
    const completedIdx = logsEmitted.findIndex(
      (l) => l.attributes['event.name'] === 'code_review.completed',
    );
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    // The start event must precede the completion event so log-only consumers
    // can compute duration and detect stuck/hung runs.
    expect(startedIdx).toBeLessThan(completedIdx);

    const started = logsEmitted[startedIdx];
    expect(started.body).toMatch(/review started: proj MR#1/);
    expect(started.context).toBeDefined();
    expect(started.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'event.name': 'code_review.started',
      'vcs.repository.id': 'proj',
      'vcs.change.id': '1',
      'code_review.run_id': 'run-otel',
      'code_review.dry_run': false,
      'gen_ai.request.model': 'claude-sonnet-4-5',
    });
  });

  it('emits a review.failed ERROR log with error.type and error.message on failure', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-failed-log');
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw new ReviewerError('parser blew up');
      }),
    ).rejects.toThrow('parser blew up');
    await bridge!.shutdown();

    const failed = fake.logsEmitted.find(
      (l) => l.attributes['event.name'] === 'code_review.failed',
    );
    expect(failed).toBeDefined();
    expect(failed!.severityNumber).toBe(SeverityNumber.ERROR);
    expect(failed!.body).toMatch(/review failed: mygroup\/myrepo MR#7 — parser blew up/);
    expect(failed!.context).toBeDefined();
    expect(failed!.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'event.name': 'code_review.failed',
      'error.type': 'REVIEWER_ERROR',
      'error.message': 'parser blew up',
      'code_review.run_id': 'run-failed-log',
    });
    // A failed run must NOT also emit a success completion record.
    expect(
      fake.logsEmitted.some((l) => l.attributes['event.name'] === 'code_review.completed'),
    ).toBe(false);
  });

  it('puts the HTTP status on the failed log for a GitLab API error', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-failed-log-500');
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw new GitLabApiError('GitLab API POST /draft_notes/bulk_publish failed: 500', {
          method: 'POST',
          path: '/draft_notes/bulk_publish',
          status: 500,
        });
      }),
    ).rejects.toThrow();
    await bridge!.shutdown();

    const failed = fake.logsEmitted.find(
      (l) => l.attributes['event.name'] === 'code_review.failed',
    );
    expect(failed!.attributes).toMatchObject({
      'error.type': 'GITLAB_API_ERROR_500',
      'http.response.status_code': 500,
    });
  });

  it('emits a review.started log even when the run fails', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-started-fail');
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw new Error('early failure');
      }),
    ).rejects.toThrow('early failure');
    await bridge!.shutdown();

    expect(fake.logsEmitted.some((l) => l.attributes['event.name'] === 'code_review.started')).toBe(
      true,
    );
  });

  it('emits review completion log and comment logs with root span context for trace correlation', async () => {
    // BUG 2 regression test: logger.emit was previously called without a context
    // so the logger SDK could not stamp traceId/spanId on Loki log records.
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runId = 'run-log-correlation';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async (ctx) => {
        ctx.usage = {
          model: 'anthropic/claude-sonnet-4-5',
          tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        };
      });
      bridge!.logComments(
        [
          {
            comment: { file: 'x.ts', line: 1, side: 'RIGHT', severity: 'info', body: 'test' },
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
        ],
        runId,
      );
    });
    await bridge!.shutdown();

    // The review completion log must carry a non-undefined context so the logger
    // SDK can extract traceId/spanId and correlate the log record to the trace.
    const completedLog = fake.logsEmitted.find(
      (l) => l.attributes['event.name'] === 'code_review.completed',
    );
    expect(completedLog).toBeDefined();
    expect(completedLog!.context).toBeDefined();
    // The context must contain the root span (invoke_workflow span).
    const spanFromCtx = trace.getSpan(
      completedLog!.context as import('@opentelemetry/api').Context,
    );
    expect(spanFromCtx).toBeDefined();

    // Comment logs must also carry trace context.
    const commentLog = fake.logsEmitted.find(
      (l) => l.attributes['event.name'] === 'code_review.comment',
    );
    expect(commentLog).toBeDefined();
    expect(commentLog!.context).toBeDefined();
  });

  it('logComments emits one log record per comment with file/line/severity/is_duplicate', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
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
      reviewDepth: 'single',
      apiKey: 'k',
      reviewFile: 'code-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
      postSummary: false,
      forceReview: false,
      verbose: false,
      cwd: '/tmp',
      skills: [],
      refreshGitSkills: false,
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
      (l) => l.attributes['event.name'] === 'code_review.comment',
    );
    expect(commentLogs).toHaveLength(2);

    const [auth, utils] = commentLogs;
    expect(auth.body).toContain('[critical] src/auth.ts:42');
    expect(auth.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'vcs.repository.id': 'acme/web',
      'vcs.change.id': '42',
      'code_review.run_id': 'run-logs',
      'code_review.comment.file': 'src/auth.ts',
      'code_review.comment.line': 42,
      'code_review.comment.severity': 'critical',
      'code_review.comment.is_duplicate': false,
    });
    expect(utils.attributes['code_review.comment.is_duplicate']).toBe(true);
  });

  it('propagates CI_* env vars as gitlab.* attributes on spans, metrics, and logs', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: {
        CODE_REVIEW_OTEL: '1',
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
      reviewDepth: 'single',
      apiKey: 'k',
      reviewFile: 'code-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
      postSummary: false,
      forceReview: false,
      verbose: false,
      cwd: '/tmp',
      skills: [],
      refreshGitSkills: false,
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
      'vcs.repository.name': 'my-group/my-project',
      'vcs.owner.name': 'my-group',
      'vcs.ref.base.name': 'main',
      'cicd.pipeline.source': 'merge_request_event',
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
    // Review-level metrics carry at least vcs.repository.name (the primary
    // grouping dimension); other CI attrs are omitted per the metric spec.
    const reviewMetrics = fake.metricsRecorded.filter((m) => m.name.startsWith('code_review_'));
    for (const metric of reviewMetrics) {
      expect(metric.attributes['vcs.repository.name']).toBe('my-group/my-project');
    }

    // Review completion log carries CI attrs.
    const completedLog = fake.logsEmitted.find(
      (l) => l.attributes['event.name'] === 'code_review.completed',
    );
    expect(completedLog?.attributes).toMatchObject(expectedCiAttrs);
  });

  it('omits vcs.repository.name and siblings when CI vars are absent', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });
    // runWithBridge passes env: { CODE_REVIEW_OTEL: '1' } with no CI_* vars.
    // The operation duration metric (still from recordGenAiMetrics) must have no
    // CI attributes when CI env vars are absent.
    const duration = metricsRecorded.find((m) => m.name === 'gen_ai.client.operation.duration');
    expect(duration?.attributes).not.toHaveProperty('vcs.repository.name');
    expect(duration?.attributes).not.toHaveProperty('vcs.owner.name');
    expect(duration?.attributes).not.toHaveProperty('vcs.ref.base.name');
    expect(duration?.attributes).not.toHaveProperty('cicd.pipeline.source');
  });

  it('adds CI_JOB_ID and CI_PIPELINE_ID to spans and logs but not to metric attributes', async () => {
    // MINOR 3: high-cardinality CI identifiers should enrich traces and logs for
    // debugging but must not be labels on Prometheus metrics (cardinality bomb).
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: {
        CODE_REVIEW_OTEL: '1',
        CI_PROJECT_PATH: 'my-group/my-project',
        CI_JOB_ID: '12345',
        CI_PIPELINE_ID: '67890',
      },
    });

    const config = makeConfig();
    const runId = 'run-ci-span-attrs';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async (ctx) => {
        ctx.usage = {
          model: 'anthropic/claude-sonnet-4-5',
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
          cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
        };
      });
    });
    await bridge!.shutdown();

    // Spans should carry both low- and high-cardinality CI attrs.
    for (const span of fake.spans) {
      const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
      expect(attrs['cicd.pipeline.task.run.id']).toBe('12345');
      expect(attrs['cicd.pipeline.run.id']).toBe('67890');
    }

    // Review completion log should also carry the high-cardinality attrs.
    const completedLog = fake.logsEmitted.find(
      (l) => l.attributes['event.name'] === 'code_review.completed',
    );
    expect(completedLog?.attributes['cicd.pipeline.task.run.id']).toBe('12345');
    expect(completedLog?.attributes['cicd.pipeline.run.id']).toBe('67890');

    // gen_ai.* metric data points must NOT carry high-cardinality CI IDs.
    const genAiMetrics = fake.metricsRecorded.filter((m) => m.name.startsWith('gen_ai.'));
    for (const metric of genAiMetrics) {
      expect(metric.attributes).not.toHaveProperty('cicd.pipeline.task.run.id');
      expect(metric.attributes).not.toHaveProperty('cicd.pipeline.run.id');
    }
  });

  it('logComments truncates comment body at 500 chars', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
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
      reviewDepth: 'single',
      apiKey: 'k',
      reviewFile: 'code-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
      postSummary: false,
      forceReview: false,
      verbose: false,
      cwd: '/tmp',
      skills: [],
      refreshGitSkills: false,
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

    const log = fake.logsEmitted.find((l) => l.attributes['event.name'] === 'code_review.comment');
    // The log body includes the prefix "[info] a.ts:1 — " plus the truncated body.
    expect(log!.body).toContain('…');
    // Total body should not exceed ~520 chars (prefix + 500 content chars + ellipsis)
    expect(log!.body.length).toBeLessThan(520);
  });

  // ---------------------------------------------------------------------------
  // Review-level OTel metrics (code_review_* instruments)
  // ---------------------------------------------------------------------------

  it('emits code_review_run_duration_seconds and code_review_total_cost_usd on success', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
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
      (m) => m.name === 'code_review_run_duration_seconds',
    );
    expect(runDuration).toBeDefined();
    expect(typeof runDuration!.value).toBe('number');
    expect(runDuration!.value).toBeGreaterThanOrEqual(0);
    expect(runDuration!.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'code_review.dry_run': false,
      'code_review.status': 'success',
    });

    const totalCost = fake.metricsRecorded.find((m) => m.name === 'code_review_total_cost_usd');
    expect(totalCost).toBeDefined();
    expect(totalCost!.value).toBeCloseTo(0.03);
    expect(totalCost!.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'code_review.dry_run': false,
      'code_review.status': 'success',
    });
  });

  it('emits code_review_comments_total and code_review_drafts_published_total', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runId = 'run-counters';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async (ctx) => {
      // Simulate the post_comments phase populating draftsPublished.
      const postContext = createDiagnosticContext('scm.post_comments', config, runId);
      await traceDiagnostic(diagnosticChannels.postComments, postContext, async (pCtx) => {
        pCtx.draftsPublished = 4;
      });
      // Root context carries the comments-posted count.
      ctx.posted = 6;
    });
    await bridge!.shutdown();

    const comments = fake.metricsRecorded.find((m) => m.name === 'code_review_comments_total');
    expect(comments).toBeDefined();
    expect(comments!.value).toBe(6);
    expect(comments!.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'code_review.dry_run': false,
    });

    const drafts = fake.metricsRecorded.find(
      (m) => m.name === 'code_review_drafts_published_total',
    );
    expect(drafts).toBeDefined();
    expect(drafts!.value).toBe(4);
    expect(drafts!.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'code_review.dry_run': false,
    });
  });

  it('does not emit code_review_comments_total when posted count is zero', async () => {
    // MINOR 2: emitting a zero-increment counter is wasteful and can create
    // spurious series in Prometheus on error/dry-run paths.
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.posted = 0;
    });
    const comments = metricsRecorded.find((m) => m.name === 'code_review_comments_total');
    expect(comments).toBeUndefined();
  });

  it('breaks code_review_comments_total down by code_review.comment.severity', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-comment-severity');
    await traceDiagnostic(diagnosticChannels.run, runContext, async (ctx) => {
      ctx.posted = 6;
      ctx.postedBySeverity = { critical: 2, warn: 1, info: 3 };
    });
    await bridge!.shutdown();

    const comments = fake.metricsRecorded.filter((m) => m.name === 'code_review_comments_total');
    expect(comments).toHaveLength(3);
    const bySeverity = Object.fromEntries(
      comments.map((m) => [m.attributes['code_review.comment.severity'], m.value]),
    );
    expect(bySeverity).toEqual({ critical: 2, warn: 1, info: 3 });
    // The per-severity data points still carry the shared review label set.
    expect(comments[0].attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'code_review.dry_run': false,
    });
  });

  it('emits code_review_phase_duration_seconds for every measured phase', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });

    const phaseDurations = metricsRecorded.filter(
      (m) => m.name === 'code_review_phase_duration_seconds',
    );
    // runWithBridge opens `run` and `reviewer.run` phases — both must emit.
    expect(phaseDurations.length).toBeGreaterThanOrEqual(2);

    const reviewerPhase = phaseDurations.find(
      (m) => m.attributes['code_review.phase'] === 'reviewer.run',
    );
    expect(reviewerPhase).toBeDefined();
    expect(typeof reviewerPhase!.value).toBe('number');
    expect(reviewerPhase!.value).toBeGreaterThanOrEqual(0);
    expect(reviewerPhase!.attributes['service.name']).toBe('@weareikko/code-review');
    expect(reviewerPhase!.attributes['code_review.status']).toBe('success');

    const runPhase = phaseDurations.find((m) => m.attributes['code_review.phase'] === 'run');
    expect(runPhase).toBeDefined();
    expect(runPhase!.attributes['service.name']).toBe('@weareikko/code-review');
    expect(runPhase!.attributes['code_review.status']).toBe('success');
  });

  it('sets code_review.status=error on run-level metrics when the run throws', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
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
      (m) => m.name === 'code_review_run_duration_seconds',
    );
    expect(runDuration).toBeDefined();
    expect(runDuration!.attributes['code_review.status']).toBe('error');

    const phaseDuration = fake.metricsRecorded.find(
      (m) =>
        m.name === 'code_review_phase_duration_seconds' &&
        m.attributes['code_review.phase'] === 'run',
    );
    expect(phaseDuration!.attributes['code_review.status']).toBe('error');
  });

  it('sets code_review.status=timeout when the run is aborted', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
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
      (m) => m.name === 'code_review_run_duration_seconds',
    );
    expect(runDuration).toBeDefined();
    expect(runDuration!.attributes['code_review.status']).toBe('timeout');
  });

  it('omits code_review_total_cost_usd when no usage is recorded', async () => {
    const { metricsRecorded } = await runWithBridge(async () => {
      // No ctx.usage set — reviewer phase produces no cost data.
    });

    expect(metricsRecorded.find((m) => m.name === 'code_review_total_cost_usd')).toBeUndefined();
  });

  it('carries cicd.pipeline.source on code_review_run_duration_seconds when CI var is set', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: {
        CODE_REVIEW_OTEL: '1',
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
      (m) => m.name === 'code_review_run_duration_seconds',
    );
    expect(runDuration!.attributes).toMatchObject({
      'vcs.repository.name': 'corp/svc',
      'cicd.pipeline.source': 'merge_request_event',
    });
  });

  // ---------------------------------------------------------------------------
  // code_review_runs_total — one increment per run (fixes dashboard counting)
  // ---------------------------------------------------------------------------

  it('emits code_review_runs_total exactly once per successful run', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });

    const runs = metricsRecorded.filter((m) => m.name === 'code_review_runs_total');
    expect(runs).toHaveLength(1);
    expect(runs[0].value).toBe(1);
    expect(runs[0].attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'code_review.dry_run': false,
      'code_review.status': 'success',
    });
    // run_id is intentionally NOT a metric label — it would explode cardinality.
    expect(runs[0].attributes['code_review.run_id']).toBeUndefined();
  });

  it('increments code_review_runs_total with status=error when the run throws', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-runs-error');
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw new Error('kaboom');
      }),
    ).rejects.toThrow('kaboom');
    await bridge!.shutdown();

    const runs = fake.metricsRecorded.filter((m) => m.name === 'code_review_runs_total');
    expect(runs).toHaveLength(1);
    expect(runs[0].value).toBe(1);
    expect(runs[0].attributes['code_review.status']).toBe('error');
  });

  it('carries vcs.repository.name and pipeline_source on code_review_runs_total', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: {
        CODE_REVIEW_OTEL: '1',
        CI_PROJECT_PATH: 'corp/svc',
        CI_PIPELINE_SOURCE: 'merge_request_event',
      },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-runs-ci');
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {});
    await bridge!.shutdown();

    const runs = fake.metricsRecorded.find((m) => m.name === 'code_review_runs_total');
    expect(runs!.attributes).toMatchObject({
      'vcs.repository.name': 'corp/svc',
      'cicd.pipeline.source': 'merge_request_event',
      'code_review.status': 'success',
    });
  });

  // ---------------------------------------------------------------------------
  // code_review_errors_total — one increment per failed run, by error_type
  // ---------------------------------------------------------------------------

  it('emits code_review_errors_total with error.type when the run throws', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-errors-total');
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw new ReviewerError('boom');
      }),
    ).rejects.toThrow('boom');
    await bridge!.shutdown();

    const errors = fake.metricsRecorded.filter((m) => m.name === 'code_review_errors_total');
    expect(errors).toHaveLength(1);
    expect(errors[0].value).toBe(1);
    expect(errors[0].attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'code_review.status': 'error',
      // error.type prefers the typed-error code over the class name.
      'error.type': 'REVIEWER_ERROR',
    });
  });

  it('refines error.type with the HTTP status for GitLab API errors (e.g. a 500 on bulk_publish)', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-errors-bulk-publish');
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw new GitLabApiError(
          'GitLab API POST /draft_notes/bulk_publish failed: 500 Internal Server Error',
          { method: 'POST', path: '/draft_notes/bulk_publish', status: 500 },
        );
      }),
    ).rejects.toThrow('bulk_publish');
    await bridge!.shutdown();

    const errors = fake.metricsRecorded.find((m) => m.name === 'code_review_errors_total');
    expect(errors!.attributes).toMatchObject({
      'code_review.status': 'error',
      // The bare GITLAB_API_ERROR code is refined with the status so a 500 on
      // bulk_publish is distinguishable from a 404/401 in alerting.
      'error.type': 'GITLAB_API_ERROR_500',
    });
  });

  it('labels code_review_errors_total status=timeout for abort errors', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-errors-timeout');
    const abortError = Object.assign(new Error('aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw abortError;
      }),
    ).rejects.toThrow('aborted');
    await bridge!.shutdown();

    const errors = fake.metricsRecorded.find((m) => m.name === 'code_review_errors_total');
    expect(errors!.attributes).toMatchObject({
      'code_review.status': 'timeout',
      'error.type': 'ABORT_ERR',
    });
  });

  it('labels status=timeout for wrapped typed errors that flag timeout=true', async () => {
    // Production timeouts never reach the run phase as a raw AbortError — a GitLab
    // timeout is wrapped in GitLabApiError and a reviewer timeout in ReviewerError.
    // Those carry the timeout flag (via toDiagnosticError), which must still map
    // to status=timeout, otherwise the bucket is dead in practice.
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
    });

    const config = makeConfig();
    const runContext = createDiagnosticContext('run', config, 'run-errors-wrapped-timeout');
    await expect(
      traceDiagnostic(diagnosticChannels.run, runContext, async () => {
        throw new ReviewerError('Review timed out after 600s', { timeout: true });
      }),
    ).rejects.toThrow('timed out');
    await bridge!.shutdown();

    const errors = fake.metricsRecorded.find((m) => m.name === 'code_review_errors_total');
    expect(errors!.attributes).toMatchObject({
      'code_review.status': 'timeout',
      'error.type': 'REVIEWER_ERROR',
    });
    const runs = fake.metricsRecorded.find((m) => m.name === 'code_review_runs_total');
    expect(runs!.attributes['code_review.status']).toBe('timeout');
  });

  it('does not emit code_review_errors_total on a successful run', async () => {
    const { metricsRecorded } = await runWithBridge(async () => {});
    expect(metricsRecorded.find((m) => m.name === 'code_review_errors_total')).toBeUndefined();
  });

  it('labels run duration and total cost histograms with gen_ai.request.model', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      };
    });

    const runDuration = metricsRecorded.find((m) => m.name === 'code_review_run_duration_seconds');
    expect(runDuration!.attributes['gen_ai.request.model']).toBe('claude-sonnet-4-5');

    const totalCost = metricsRecorded.find((m) => m.name === 'code_review_total_cost_usd');
    expect(totalCost!.attributes['gen_ai.request.model']).toBe('claude-sonnet-4-5');
  });

  it('omits gen_ai.request.model from run histograms when usage/model is unknown', async () => {
    const { metricsRecorded } = await runWithBridge(async () => {});
    const runDuration = metricsRecorded.find((m) => m.name === 'code_review_run_duration_seconds');
    expect(runDuration).toBeDefined();
    expect(runDuration!.attributes['gen_ai.request.model']).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // LLM token total counters — token consumption as Prometheus counters
  // ---------------------------------------------------------------------------

  it('emits code_review_llm_*_tokens_total counters from aggregated usage', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, total: 1550 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 },
      };
    });

    const byName = (name: string) => metricsRecorded.find((m) => m.name === name);
    expect(byName('code_review_llm_input_tokens_total')?.value).toBe(1000);
    expect(byName('code_review_llm_output_tokens_total')?.value).toBe(200);
    expect(byName('code_review_llm_cache_read_tokens_total')?.value).toBe(300);
    expect(byName('code_review_llm_cache_creation_tokens_total')?.value).toBe(50);

    expect(byName('code_review_llm_input_tokens_total')?.attributes).toMatchObject({
      'service.name': '@weareikko/code-review',
      'gen_ai.request.model': 'claude-sonnet-4-5',
    });
  });

  it('omits cache token counters when no cache tokens were used', async () => {
    const { metricsRecorded } = await runWithBridge(async (ctx) => {
      ctx.usage = {
        model: 'anthropic/claude-sonnet-4-5',
        tokens: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, total: 600 },
        cost: { input: 0.005, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.015 },
      };
    });

    expect(
      metricsRecorded.find((m) => m.name === 'code_review_llm_input_tokens_total'),
    ).toBeDefined();
    expect(
      metricsRecorded.find((m) => m.name === 'code_review_llm_cache_read_tokens_total'),
    ).toBeUndefined();
    expect(
      metricsRecorded.find((m) => m.name === 'code_review_llm_cache_creation_tokens_total'),
    ).toBeUndefined();
  });

  it('emits no LLM token counters when usage is absent', async () => {
    const { metricsRecorded } = await runWithBridge(async () => {});
    expect(metricsRecorded.some((m) => m.name.startsWith('code_review_llm_'))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // isContentCaptureEnabled
  // ---------------------------------------------------------------------------

  it('isContentCaptureEnabled returns false unless explicitly opted in', () => {
    expect(isContentCaptureEnabled({})).toBe(false);
    expect(isContentCaptureEnabled({ CODE_REVIEW_OTEL_CAPTURE_CONTENT: '0' })).toBe(false);
    expect(isContentCaptureEnabled({ CODE_REVIEW_OTEL_CAPTURE_CONTENT: 'yes' })).toBe(false);
    expect(isContentCaptureEnabled({ CODE_REVIEW_OTEL_CAPTURE_CONTENT: '1' })).toBe(true);
    expect(isContentCaptureEnabled({ CODE_REVIEW_OTEL_CAPTURE_CONTENT: 'true' })).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Content capture — CODE_REVIEW_OTEL_CAPTURE_CONTENT
  // ---------------------------------------------------------------------------

  it('does not attach gen_ai.output.messages or tool content by default', async () => {
    const fakeMsg = {
      role: 'assistant',
      model: 'anthropic/claude-haiku-4-5',
      stopReason: 'end_turn',
      // Add content blocks that would be captured if the flag were set.
      content: [{ type: 'text', text: 'Here is the review.' }],
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    };
    const { spans } = await runWithAgentTelemetry(async (agent) => {
      await agent.emit({ type: 'turn_start', turnIndex: 1 });
      await agent.emit({
        type: 'tool_execution_start',
        toolName: 'Read',
        toolCallId: 'tc-no-capture',
        args: { file: 'src/main.ts' },
      });
      await agent.emit({
        type: 'tool_execution_end',
        toolCallId: 'tc-no-capture',
        toolName: 'Read',
        result: 'file contents',
        isError: false,
      });
      await agent.emit({ type: 'message_end', message: fakeMsg });
    });

    const turnSpan = spans.find((s) => s.name === 'gen_ai.agent.turn');
    const turnAttrs = Object.fromEntries(turnSpan!.attributes.map((a) => [a.key, a.value]));
    expect(turnAttrs).not.toHaveProperty('gen_ai.output.messages');

    const toolSpan = spans.find((s) => s.name === 'execute_tool Read');
    const toolAttrs = Object.fromEntries(toolSpan!.attributes.map((a) => [a.key, a.value]));
    expect(toolAttrs).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(toolAttrs).not.toHaveProperty('gen_ai.tool.call.result');
  });

  it('attaches gen_ai.output.messages to turn spans when captureContent=true', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
      captureContent: true,
    });

    const config = makeConfig({ model: 'anthropic/claude-haiku-4-5' });
    const runId = 'run-capture-output';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async () => {
        const attach = bridge!.createAgentTelemetry(runId);
        expect(attach).toBeDefined();
        const agent = makeAgent();
        const detach = attach!(agent);
        await agent.emit({ type: 'turn_start', turnIndex: 1 });
        await agent.emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'anthropic/claude-haiku-4-5',
            stopReason: 'end_turn',
            content: [
              { type: 'text', text: 'This is a review comment.' },
              { type: 'thinking', thinking: 'internal reasoning' }, // should be ignored
            ],
            usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
          },
        });
        detach();
      });
    });
    await bridge!.shutdown();

    const turnSpan = fake.spans.find((s) => s.name === 'gen_ai.agent.turn');
    const attrs = Object.fromEntries(turnSpan!.attributes.map((a) => [a.key, a.value]));
    expect(attrs).toHaveProperty('gen_ai.output.messages');
    const parsed = JSON.parse(attrs['gen_ai.output.messages'] as string) as unknown[];
    expect(parsed).toEqual([
      { role: 'assistant', parts: [{ type: 'text', text: 'This is a review comment.' }] },
    ]);
  });

  it('attaches tool arguments and results when captureContent=true', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
      captureContent: true,
    });

    const config = makeConfig({ model: 'anthropic/claude-haiku-4-5' });
    const runId = 'run-capture-tools';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async () => {
        const attach = bridge!.createAgentTelemetry(runId);
        const agent = makeAgent();
        const detach = attach!(agent);
        await agent.emit({ type: 'turn_start', turnIndex: 1 });
        await agent.emit({
          type: 'tool_execution_start',
          toolName: 'Read',
          toolCallId: 'tc-cap-1',
          args: { file_path: '/src/auth.ts' },
        });
        await agent.emit({
          type: 'tool_execution_end',
          toolCallId: 'tc-cap-1',
          toolName: 'Read',
          result: { content: 'const x = 1;' },
          isError: false,
        });
        await agent.emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'anthropic/claude-haiku-4-5',
            stopReason: 'tool_use',
            content: [],
            usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
          },
        });
        detach();
      });
    });
    await bridge!.shutdown();

    const toolSpan = fake.spans.find((s) => s.name === 'execute_tool Read');
    expect(toolSpan).toBeDefined();
    const attrs = Object.fromEntries(toolSpan!.attributes.map((a) => [a.key, a.value]));
    expect(attrs).toHaveProperty('gen_ai.tool.call.arguments');
    expect(JSON.parse(attrs['gen_ai.tool.call.arguments'] as string)).toEqual({
      file_path: '/src/auth.ts',
    });
    expect(attrs).toHaveProperty('gen_ai.tool.call.result');
    expect(JSON.parse(attrs['gen_ai.tool.call.result'] as string)).toEqual({
      content: 'const x = 1;',
    });
  });

  it('truncates serialized content at 2000 chars to protect span attribute size', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1' },
      captureContent: true,
    });

    const config = makeConfig({ model: 'anthropic/claude-haiku-4-5' });
    const runId = 'run-capture-trunc';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async () => {
        const attach = bridge!.createAgentTelemetry(runId);
        const agent = makeAgent();
        const detach = attach!(agent);
        await agent.emit({ type: 'turn_start', turnIndex: 1 });
        await agent.emit({
          type: 'tool_execution_start',
          toolName: 'Read',
          toolCallId: 'tc-trunc',
          args: { content: 'x'.repeat(5000) },
        });
        await agent.emit({
          type: 'tool_execution_end',
          toolCallId: 'tc-trunc',
          toolName: 'Read',
          result: 'y'.repeat(5000),
          isError: false,
        });
        await agent.emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'anthropic/claude-haiku-4-5',
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'z'.repeat(5000) }],
            usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
          },
        });
        detach();
      });
    });
    await bridge!.shutdown();

    const toolSpan = fake.spans.find((s) => s.name === 'execute_tool Read');
    const toolAttrs = Object.fromEntries(toolSpan!.attributes.map((a) => [a.key, a.value]));
    expect((toolAttrs['gen_ai.tool.call.arguments'] as string).length).toBeLessThanOrEqual(2000);
    expect((toolAttrs['gen_ai.tool.call.result'] as string).length).toBeLessThanOrEqual(2000);

    const turnSpan = fake.spans.find((s) => s.name === 'gen_ai.agent.turn');
    const turnAttrs = Object.fromEntries(turnSpan!.attributes.map((a) => [a.key, a.value]));
    expect((turnAttrs['gen_ai.output.messages'] as string).length).toBeLessThanOrEqual(2000);
  });

  it('CODE_REVIEW_OTEL_CAPTURE_CONTENT env var enables content capture via env option', async () => {
    const { startOtelBridge } = await import('./otel.js');
    const fake = createFakeRuntime();
    const bridge = await startOtelBridge({
      runtime: fake.runtime,
      env: { CODE_REVIEW_OTEL: '1', CODE_REVIEW_OTEL_CAPTURE_CONTENT: '1' },
    });

    const config = makeConfig({ model: 'anthropic/claude-haiku-4-5' });
    const runId = 'run-capture-env';
    const runContext = createDiagnosticContext('run', config, runId);
    await traceDiagnostic(diagnosticChannels.run, runContext, async () => {
      const reviewerContext = createDiagnosticContext('reviewer.run', config, runId);
      await traceDiagnostic(diagnosticChannels.runReviewer, reviewerContext, async () => {
        const attach = bridge!.createAgentTelemetry(runId);
        const agent = makeAgent();
        const detach = attach!(agent);
        await agent.emit({ type: 'turn_start', turnIndex: 1 });
        await agent.emit({
          type: 'tool_execution_start',
          toolName: 'Bash',
          toolCallId: 'tc-env',
          args: { command: 'ls' },
        });
        await agent.emit({
          type: 'tool_execution_end',
          toolCallId: 'tc-env',
          toolName: 'Bash',
          result: 'file1.ts\nfile2.ts',
          isError: false,
        });
        await agent.emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'anthropic/claude-haiku-4-5',
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'Done.' }],
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          },
        });
        detach();
      });
    });
    await bridge!.shutdown();

    const toolSpan = fake.spans.find((s) => s.name === 'execute_tool Bash');
    const toolAttrs = Object.fromEntries(toolSpan!.attributes.map((a) => [a.key, a.value]));
    expect(toolAttrs['gen_ai.tool.call.arguments']).toBeDefined();
    expect(toolAttrs['gen_ai.tool.call.result']).toBeDefined();

    const turnSpan = fake.spans.find((s) => s.name === 'gen_ai.agent.turn');
    const turnAttrs = Object.fromEntries(turnSpan!.attributes.map((a) => [a.key, a.value]));
    expect(turnAttrs['gen_ai.output.messages']).toBeDefined();
  });
});
