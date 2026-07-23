import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { collectSecrets, scrubSecrets } from './diagnostics.js';
import { ConfigError, GitLabApiError, ReviewerError } from './errors.js';
import {
  createDiagnosticContext,
  diagnosticChannels,
  traceDiagnostic,
  traceDiagnosticPhase,
  type DiagnosticContext,
} from './review.js';

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
  reviewDepth: 'single',
  apiKey: 'key',
  reviewFile: 'code-review.md',
  output: 'review-comments.json',
  dryRun: true,
  noPost: false,
  postSummary: false,
  forceReview: false,
  verbose: false,
  cwd: '/tmp',
  skills: [],
  refreshGitSkills: false,
};

describe('diagnostics_channel instrumentation', () => {
  it('sets gitlabUrl to the platform server URL (github → githubServerUrl)', () => {
    const gh = createDiagnosticContext(
      'run',
      { ...diagnosticConfig, platform: 'github', githubServerUrl: 'https://github.com' },
      'run-gh',
    );
    expect(gh.gitlabUrl).toBe('https://github.com');
    expect(gh.platform).toBe('github');

    const gl = createDiagnosticContext(
      'run',
      { ...diagnosticConfig, platform: 'gitlab', gitlabUrl: 'https://gitlab.example.com' },
      'run-gl',
    );
    expect(gl.gitlabUrl).toBe('https://gitlab.example.com');
  });

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

  it('captures the HTTP status from a GitLab API error so the bridge can label it', async () => {
    const errors: DiagnosticContext[] = [];
    const onError = (message: DiagnosticContext) => errors.push(message);

    diagnosticChannels.run.error.subscribe(onError);
    try {
      const context = createDiagnosticContext('run', diagnosticConfig, 'run-http-500');
      await expect(
        traceDiagnostic(diagnosticChannels.run, context, async () => {
          throw new GitLabApiError('GitLab API POST /draft_notes/bulk_publish failed: 500', {
            method: 'POST',
            path: '/draft_notes/bulk_publish',
            status: 500,
          });
        }),
      ).rejects.toThrow();
    } finally {
      diagnosticChannels.run.error.unsubscribe(onError);
    }

    expect(errors[0].errorInfo).toMatchObject({
      name: 'GitLabApiError',
      code: 'GITLAB_API_ERROR',
      status: 500,
    });
  });

  it('leaves status undefined for errors without an HTTP status', async () => {
    const errors: DiagnosticContext[] = [];
    const onError = (message: DiagnosticContext) => errors.push(message);

    diagnosticChannels.run.error.subscribe(onError);
    try {
      const context = createDiagnosticContext('run', diagnosticConfig, 'run-no-status');
      await expect(
        traceDiagnostic(diagnosticChannels.run, context, async () => {
          throw new ConfigError('bad config');
        }),
      ).rejects.toThrow();
    } finally {
      diagnosticChannels.run.error.unsubscribe(onError);
    }

    expect(errors[0].errorInfo?.status).toBeUndefined();
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

  it("scrubs the run's own secret values from error messages stored on the trace", async () => {
    const errors: DiagnosticContext[] = [];
    const onError = (message: DiagnosticContext) => errors.push(message);
    const secretConfig: Config = {
      ...diagnosticConfig,
      gitlabToken: 'glpat-ABCDEFGHIJKLMNOPQRSTUV',
      apiKey: 'sk-ant-secretkeyvalue0123456789',
    };

    diagnosticChannels.run.error.subscribe(onError);
    try {
      await expect(
        traceDiagnosticPhase('run', secretConfig, 'run-secret', async () => {
          throw new GitLabApiError(
            'auth failed for PRIVATE-TOKEN glpat-ABCDEFGHIJKLMNOPQRSTUV (key sk-ant-secretkeyvalue0123456789)',
            { method: 'GET', path: '/user' },
          );
        }),
      ).rejects.toThrow();
    } finally {
      diagnosticChannels.run.error.unsubscribe(onError);
    }

    const message = errors[0].errorInfo?.message ?? '';
    expect(message).not.toContain('glpat-ABCDEFGHIJKLMNOPQRSTUV');
    expect(message).not.toContain('sk-ant-secretkeyvalue0123456789');
    expect(message).toContain('[REDACTED]');
  });
});

describe('scrubSecrets', () => {
  const SECRET = 'glpat-ABCDEFGHIJKLMNOPQRSTUV';

  it('removes the raw secret value', () => {
    expect(scrubSecrets(`token ${SECRET} rejected`, [SECRET])).toBe('token [REDACTED] rejected');
  });

  it('removes a URL-encoded occurrence of the secret', () => {
    const secret = 'p@ss/word+value';
    const input = `failed: https://api/x?token=${encodeURIComponent(secret)}`;
    expect(scrubSecrets(input, [secret])).toBe('failed: https://api/x?token=[REDACTED]');
  });

  it('removes a base64-encoded occurrence of the secret', () => {
    const b64 = Buffer.from(SECRET, 'utf8').toString('base64');
    expect(scrubSecrets(`authorization header was ${b64}`, [SECRET])).toBe(
      'authorization header was [REDACTED]',
    );
  });

  it('scrubs multiple secret values in one pass', () => {
    const a = 'glpat-ABCDEFGHIJKLMNOPQRSTUV';
    const b = 'sk-ant-secretkeyvalue0123456789';
    expect(scrubSecrets(`gitlab=${a} llm=${b}`, [a, b])).toBe('gitlab=[REDACTED] llm=[REDACTED]');
  });

  it('does not treat values shorter than 6 chars as secrets', () => {
    expect(scrubSecrets('the cat sat on the mat', ['cat', 'mat'])).toBe('the cat sat on the mat');
  });

  it('leaves ordinary error text untouched when no secret is present', () => {
    const message = 'could not connect to database: connection refused (Token expired)';
    expect(scrubSecrets(message, [SECRET])).toBe(message);
  });

  it('returns the input unchanged when there are no secret values', () => {
    expect(scrubSecrets('Bearer Token Basic auth check failed', [])).toBe(
      'Bearer Token Basic auth check failed',
    );
  });
});

describe('collectSecrets', () => {
  it('returns the non-empty token and api key', () => {
    expect(
      collectSecrets({ ...diagnosticConfig, gitlabToken: 'tok123', apiKey: 'key456' }),
    ).toEqual(['tok123', 'key456']);
  });

  it('omits empty secret values', () => {
    expect(collectSecrets({ ...diagnosticConfig, gitlabToken: 'tok123', apiKey: '' })).toEqual([
      'tok123',
    ]);
  });
});
