import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { redactSecrets } from './diagnostics.js';
import { ConfigError, GitLabApiError, ReviewerError } from './errors.js';
import {
  createDiagnosticContext,
  diagnosticChannels,
  traceDiagnostic,
  type DiagnosticContext,
} from './review.js';

describe('diagnostics_channel instrumentation', () => {
  const diagnosticConfig: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'tok',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    apiKey: 'key',
    reviewFile: 'gitlab-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: false,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: '/tmp',
    skills: [],
  };

  it('publishes tracing channel lifecycle events with safe context', async () => {
    const events: Array<{ type: string; message: DiagnosticContext }> = [];
    const onStart = (message: DiagnosticContext) => events.push({ type: 'start', message });
    const onAsyncEnd = (message: DiagnosticContext) => events.push({ type: 'asyncEnd', message });

    diagnosticChannels.run.start.subscribe(onStart);
    diagnosticChannels.run.asyncEnd.subscribe(onAsyncEnd);
    try {
      const context = createDiagnosticContext('run', diagnosticConfig, 'run-1');
      await expect(
        traceDiagnostic(diagnosticChannels.run, context, async (activeContext) => {
          activeContext.generated = 2;
          activeContext.newComments = 1;
          return 'ok';
        }),
      ).resolves.toBe('ok');
    } finally {
      diagnosticChannels.run.start.unsubscribe(onStart);
      diagnosticChannels.run.asyncEnd.unsubscribe(onAsyncEnd);
    }

    expect(events.map((event) => event.type)).toEqual(['start', 'asyncEnd']);
    expect(events[0].message).toMatchObject({
      version: 1,
      runId: 'run-1',
      phase: 'run',
      project: 'proj',
      mr: '1',
      gitlabUrl: 'https://gitlab.example.com',
      dryRun: true,
    });
    expect(events[0].message).not.toHaveProperty('gitlabToken');
    expect(events[0].message).not.toHaveProperty('apiKey');
    expect(events[1].message).toMatchObject({ generated: 2, newComments: 1 });
    expect(events[1].message.completedAt).toEqual(expect.any(String));
    expect(events[1].message.durationMs).toEqual(expect.any(Number));
  });

  it('adds sanitized error details to failed traces', async () => {
    const errors: DiagnosticContext[] = [];
    const onError = (message: DiagnosticContext) => errors.push(message);

    diagnosticChannels.run.error.subscribe(onError);
    try {
      const context = createDiagnosticContext('run', diagnosticConfig, 'run-error');
      await expect(
        traceDiagnostic(diagnosticChannels.run, context, async () => {
          throw new ConfigError('bad config');
        }),
      ).rejects.toThrow('bad config');
    } finally {
      diagnosticChannels.run.error.unsubscribe(onError);
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].errorInfo).toMatchObject({
      name: 'ConfigError',
      message: 'bad config',
      code: 'CONFIG_ERROR',
    });
    // A non-timeout error must not be flagged as a timeout.
    expect(errors[0].errorInfo?.timeout).toBeUndefined();
  });

  it('flags timeout errors so the bridge can label the run status=timeout', async () => {
    const errors: DiagnosticContext[] = [];
    const onError = (message: DiagnosticContext) => errors.push(message);

    diagnosticChannels.run.error.subscribe(onError);
    try {
      const context = createDiagnosticContext('run', diagnosticConfig, 'run-timeout');
      await expect(
        traceDiagnostic(diagnosticChannels.run, context, async () => {
          throw new ReviewerError('Review timed out after 600s', { timeout: true });
        }),
      ).rejects.toThrow('timed out');
    } finally {
      diagnosticChannels.run.error.unsubscribe(onError);
    }

    expect(errors[0].errorInfo).toMatchObject({
      name: 'ReviewerError',
      code: 'REVIEWER_ERROR',
      timeout: true,
    });
  });

  it('redacts secrets from error messages stored on the trace', async () => {
    const errors: DiagnosticContext[] = [];
    const onError = (message: DiagnosticContext) => errors.push(message);

    diagnosticChannels.run.error.subscribe(onError);
    try {
      const context = createDiagnosticContext('run', diagnosticConfig, 'run-secret');
      await expect(
        traceDiagnostic(diagnosticChannels.run, context, async () => {
          throw new GitLabApiError('auth failed: PRIVATE-TOKEN: glpat-ABCDEFGHIJKLMNOPQRSTUV', {
            method: 'GET',
            path: '/user',
          });
        }),
      ).rejects.toThrow();
    } finally {
      diagnosticChannels.run.error.unsubscribe(onError);
    }

    expect(errors[0].errorInfo?.message).not.toContain('glpat-ABCDEFGHIJKLMNOPQRSTUV');
    expect(errors[0].errorInfo?.message).toContain('[REDACTED]');
  });
});

describe('redactSecrets', () => {
  it('masks HTTP Authorization scheme tokens', () => {
    expect(
      redactSecrets('request failed: Authorization: Bearer sk-ant-api03-abc123def456ghi'),
    ).toBe('request failed: Authorization: Bearer [REDACTED]');
  });

  it('masks GitLab personal/project access tokens', () => {
    expect(redactSecrets('token glpat-ABCDEFGHIJKLMNOPQRSTUV rejected')).toBe(
      'token [REDACTED] rejected',
    );
  });

  it('masks Anthropic/OpenAI style keys', () => {
    expect(redactSecrets('key sk-ant-api03-0123456789abcdefghij invalid')).toBe(
      'key [REDACTED] invalid',
    );
  });

  it('masks credentials embedded in URL userinfo', () => {
    expect(
      redactSecrets(
        "unable to access 'https://oauth2:glpat-secrettokenvalue1234@gitlab.example.com/x.git'",
      ),
    ).toBe("unable to access 'https://[REDACTED]@gitlab.example.com/x.git'");
  });

  it('masks the value of sensitive key=value assignments, keeping the key', () => {
    expect(redactSecrets('config error: api_key=mysecretvalue123 is invalid')).toBe(
      'config error: api_key=[REDACTED] is invalid',
    );
  });

  it('leaves ordinary error text untouched', () => {
    const message = 'could not connect to database: connection refused (global-state-manager)';
    expect(redactSecrets(message)).toBe(message);
  });
});
