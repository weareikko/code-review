import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  parseArgs,
  resolveConfig,
  validateConfig,
  type Config,
  type Severity,
} from '../src/config.js';
import { ConfigError, GitLabApiError, ReviewerError, formatError } from '../src/errors.js';
import { getMergeDiffArguments } from '../src/git.js';
import { GitLabClient } from '../src/gitlab.js';
import { runPiReviewer, shellJoin, type PiReviewOptions } from '../src/pi-reviewer.js';
import {
  appendFingerprintMarkers,
  buildGeneratedComments,
  buildPayload,
  createDiagnosticContext,
  diagnosticChannels,
  extractDiffHunkContext,
  extractExistingFingerprints,
  fingerprints,
  normalizeBody,
  parseReviewMarkdown,
  parseReviewMarkdownWithWarnings,
  traceDiagnostic,
  type DiagnosticContext,
} from '../src/review.js';

describe('config env defaults', () => {
  it('resolves GitLab CI defaults deterministically', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '123',
      CI_MERGE_REQUEST_IID: '45',
      CI_SERVER_HOST: 'gitlab.example.com',
      GITLAB_TOKEN: 'private-token',
      PI_API_KEY: 'api-key',
    });

    expect(cfg).toMatchObject({
      project: '123',
      mr: '45',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 'private-token',
      gitlabAuthHeader: 'PRIVATE-TOKEN',
      model: 'anthropic/claude-sonnet-4-5',
      minSeverity: 'info',
      reviewFile: 'pi-review.md',
      output: 'review-comments.json',
      dryRun: false,
      noPost: false,
    });
  });

  it('prefers CLI values over environment defaults', () => {
    const cfg = resolveConfig(
      [
        '--project',
        'cli-project',
        '--mr',
        '9',
        '--gitlab-url',
        'https://cli.example.com/',
        '--gitlab-token',
        'cli-token',
        '--api-key',
        'cli-key',
        '--min-severity',
        'warn',
      ],
      {
        CI_PROJECT_ID: 'env-project',
        CI_MERGE_REQUEST_IID: '8',
        CI_SERVER_URL: 'https://env.example.com',
        GITLAB_TOKEN: 'env-token',
        PI_API_KEY: 'env-key',
      },
    );

    expect(cfg).toMatchObject({
      project: 'cli-project',
      mr: '9',
      gitlabUrl: 'https://cli.example.com',
      gitlabToken: 'cli-token',
      gitlabAuthHeader: 'PRIVATE-TOKEN',
      apiKey: 'cli-key',
      minSeverity: 'warn',
    });
  });

  it('uses CI_JOB_TOKEN with JOB-TOKEN header when no private token is set', () => {
    const cfg = resolveConfig([], {
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '2',
      CI_SERVER_URL: 'https://gitlab.example.com',
      CI_JOB_TOKEN: 'job-token',
      PI_API_KEY: 'key',
    });

    expect(cfg).toMatchObject({
      gitlabToken: 'job-token',
      gitlabAuthHeader: 'JOB-TOKEN',
    });
  });
});

describe('typed errors', () => {
  it('throws ConfigError for invalid config', () => {
    expect(() => validateConfig(resolveConfig([], {}))).toThrow(ConfigError);
  });

  it('formats typed errors with code and hint', () => {
    const error = new ReviewerError('review failed', { hint: 'check logs' });
    expect(formatError(error)).toBe('[REVIEWER_ERROR] review failed\nHint: check logs');
  });
});

describe('GitLab client URL construction', () => {
  it('builds API v4 URLs and query strings from trimmed base URL', () => {
    const client = new GitLabClient({ gitlabUrl: 'https://gitlab.example.com/', token: 't' });

    expect(
      client.url('/projects/group%2Frepo/merge_requests/10/discussions', {
        page: 2,
        per_page: 100,
        include_resolved: false,
      }),
    ).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/10/discussions?page=2&per_page=100&include_resolved=false',
    );
  });

  it('encodes project path and MR IID in endpoint helpers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ source_branch: 'feature', target_branch: 'main' })),
      );
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await client.getMergeRequest('group/subgroup/repo', '12');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Fsubgroup%2Frepo/merge_requests/12',
    );
  });
});

describe('GitLab pagination with mocked fetch', () => {
  it('follows x-next-page deterministically and sends auth header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), { headers: { 'x-next-page': '2' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 2 }]), { headers: { 'x-next-page': '' } }),
      );

    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 'job-token',
      authHeader: 'JOB-TOKEN',
      fetchImpl,
    });

    await expect(client.paginate('/items')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain('per_page=100&page=1');
    expect(fetchImpl.mock.calls[1][0]).toContain('per_page=100&page=2');
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      'JOB-TOKEN': 'job-token',
      Accept: 'application/json',
    });
  });

  it('throws typed GitLabApiError on API failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('denied', {
        status: 403,
        statusText: 'Forbidden',
      }),
    );
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.request('/items')).rejects.toThrow(GitLabApiError);
  });

  it('fails when paginated payload is not an array', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 1 }), { headers: { 'x-next-page': '' } }),
      );
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.paginate('/items')).rejects.toThrow(
      'returned a non-array paginated response',
    );
  });

  it('fails on invalid x-next-page values', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ id: 1 }]), { headers: { 'x-next-page': '1' } }),
      );
    const client = new GitLabClient({
      gitlabUrl: 'https://gitlab.example.com',
      token: 't',
      fetchImpl,
    });

    await expect(client.paginate('/items')).rejects.toThrow('invalid x-next-page header: 1');
  });
});

describe('pi-reviewer integration', () => {
  const minimalConfig: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'tok',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    apiKey: 'key',
    reviewFile: 'pi-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    cwd: '/tmp',
  };

  it('builds the same merge diff arguments used for review and comment positions', () => {
    expect(getMergeDiffArguments('develop')).toEqual([
      'refs/remotes/origin/develop...HEAD',
      '--unified=20',
      '--',
    ]);
  });

  it('shell-quotes diff arguments before forwarding them to pi-reviewer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    let forwardedDiff: string | undefined;
    const review = vi.fn(async (options: PiReviewOptions) => {
      forwardedDiff = options.diff;
      await writeFile(join(cwd, 'pi-review.md'), 'ok', 'utf8');
    });

    await runPiReviewer(
      { ...minimalConfig, cwd },
      {
        cwd,
        diffArgs: getMergeDiffArguments('develop; echo pwned'),
        review,
      },
    );

    expect(review).toHaveBeenCalledTimes(1);
    expect(forwardedDiff).toBe(
      "'refs/remotes/origin/develop; echo pwned...HEAD' '--unified=20' '--'",
    );
    expect(shellJoin(["quote'test", '--'])).toBe("'quote'\\''test' '--'");
  });
});

describe('pi-review parsing', () => {
  it('parses inline comment blocks with severity and body normalization', () => {
    const markdown = [
      'Review summary',
      '== Inline Comments ==',
      '🟡 src/app.ts:10 (RIGHT)',
      'Please simplify this branch.',
      '',
      '🔴 `src/legacy.ts:5` - LEFT',
      'remove dead code <!-- pi-reviewer:fingerprint-primary:abcd -->',
    ].join('\n');

    expect(parseReviewMarkdown(markdown)).toEqual([
      {
        file: 'src/app.ts',
        line: 10,
        side: 'RIGHT',
        severity: 'warn',
        body: 'Please simplify this branch.',
      },
      {
        file: 'src/legacy.ts',
        line: 5,
        side: 'LEFT',
        severity: 'critical',
        body: 'remove dead code',
      },
    ]);
  });

  it('parses JSON comment fences and legacy markers', () => {
    const markdown = [
      '```json',
      '{"comments":[{"file":"src/a.ts","line":3,"side":"RIGHT","body":"Fix this"}]}',
      '```',
      '<!-- pi-reviewer-comment {"file":"src/b.ts","old_line":9,"body":"Old side"} -->',
    ].join('\n');

    expect(parseReviewMarkdown(markdown)).toEqual([
      { file: 'src/a.ts', line: 3, side: 'RIGHT', severity: 'info', body: 'Fix this' },
      { file: 'src/b.ts', line: 9, side: 'LEFT', severity: 'info', body: 'Old side' },
    ]);
  });

  it('emits warnings for text before the first parseable inline header', () => {
    const markdown = [
      '== Inline Comments ==',
      'I should be ignored',
      '🔵 src/file.ts:1 (RIGHT)',
      'Valid comment',
    ].join('\n');

    const result = parseReviewMarkdownWithWarnings(markdown);
    expect(result.comments).toHaveLength(1);
    expect(result.warnings).toEqual([
      'Ignored text in the inline comments section before the first parseable comment header.',
    ]);
  });
});

describe('diff hunk context', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' line1',
    '-line2',
    '+line2-updated',
    ' line3',
    '@@ -10,2 +11,3 @@',
    ' line10',
    '+line11-new',
    ' line12',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -4,2 +4,2 @@',
    '-old-b',
    '+new-b',
  ].join('\n');

  it('returns the matching hunk for right-side lines', () => {
    const hunk = extractDiffHunkContext(diff, 'src/a.ts', 11, 'RIGHT');
    expect(hunk).toContain('@@ -10,2 +11,3 @@');
    expect(hunk).toContain('+line11-new');
  });

  it('returns the matching hunk for left-side lines', () => {
    const hunk = extractDiffHunkContext(diff, 'src/a.ts', 2, 'LEFT');
    expect(hunk).toContain('@@ -1,3 +1,4 @@');
    expect(hunk).toContain('-line2');
  });

  it('returns deterministic fallback when no matching hunk exists', () => {
    expect(extractDiffHunkContext(diff, 'src/unknown.ts', 1, 'RIGHT')).toBe(
      'src/unknown.ts:RIGHT:1',
    );
  });
});

describe('fingerprints and duplicate detection', () => {
  it('normalizes comment bodies consistently', () => {
    const a = 'Fix   this\n\n<!-- pi-reviewer:fingerprint-primary:abcd -->';
    const b = 'Fix this';

    expect(normalizeBody(a)).toBe(normalizeBody(b));
  });

  it('produces stable fingerprints for semantically same bodies', () => {
    const comment = {
      file: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      severity: 'info' as const,
      body: 'Fix   this',
    };
    const sameComment = { ...comment, body: 'Fix this' };

    expect(fingerprints(comment, 'hunk-context')).toEqual(
      fingerprints(sameComment, 'hunk-context'),
    );
  });

  it('changes fingerprints when hunk context changes', () => {
    const comment = {
      file: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      severity: 'info' as const,
      body: 'Fix this',
    };
    const fpA = fingerprints(comment, 'hunk-a');
    const fpB = fingerprints(comment, 'hunk-b');

    expect(fpA.primary).not.toBe(fpB.primary);
    expect(fpA.secondary).not.toBe(fpB.secondary);
  });

  it('extracts existing markers and marks generated duplicates', () => {
    const baseComment = {
      file: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      severity: 'info' as const,
      body: 'Please rename this variable',
    };
    const hunk = '@@ -1,1 +1,2 @@\n old\n+new';
    const existing = fingerprints(baseComment, hunk);
    const existingSet = extractExistingFingerprints([
      { notes: [{ body: appendFingerprintMarkers('Existing', existing) }] },
    ]);

    const generated = buildGeneratedComments(
      [baseComment, baseComment],
      ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', hunk].join('\n'),
      { base_sha: 'base', start_sha: 'start', head_sha: 'head' },
      existingSet,
    );

    expect(generated).toHaveLength(2);
    expect(generated[0].duplicate).toBe(true);
    expect(generated[1].duplicate).toBe(true);
  });
});

describe('payload generation', () => {
  const refs = { base_sha: 'base', start_sha: 'start', head_sha: 'head' };

  it('builds right-side payloads with new_line', () => {
    const payload = buildPayload(
      { file: 'src/file.ts', line: 42, side: 'RIGHT', severity: 'info', body: 'Body' },
      'Body',
      refs,
    );

    expect(payload).toEqual({
      body: 'Body',
      position: {
        position_type: 'text',
        base_sha: 'base',
        start_sha: 'start',
        head_sha: 'head',
        old_path: 'src/file.ts',
        new_path: 'src/file.ts',
        new_line: 42,
      },
    });
  });

  it('builds left-side payloads with old_line', () => {
    const payload = buildPayload(
      { file: 'src/file.ts', line: 5, side: 'LEFT', severity: 'warn', body: 'Body' },
      'Body',
      refs,
    );

    expect(payload.position).toMatchObject({
      old_path: 'src/file.ts',
      new_path: 'src/file.ts',
      old_line: 5,
    });
    expect(payload.position.new_line).toBeUndefined();
  });
});

describe('validateConfig', () => {
  const minimalConfig: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'tok',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    apiKey: 'key',
    reviewFile: 'pi-review.md',
    output: 'review-comments.json',
    dryRun: false,
    noPost: false,
    cwd: '/tmp',
  };

  it('throws listing all missing required fields', () => {
    expect(() => validateConfig({ ...minimalConfig, project: '', mr: '' })).toThrow(
      '--project, --mr',
    );
  });

  it('throws on invalid min-severity', () => {
    expect(() => validateConfig({ ...minimalConfig, minSeverity: 'bad' as Severity })).toThrow(
      '--min-severity must be one of',
    );
  });
});

describe('parseArgs', () => {
  it('parses --key=value inline syntax', () => {
    expect(parseArgs(['--project=123'])).toMatchObject({ project: '123' });
  });

  it('parses -h and -v short flags', () => {
    expect(parseArgs(['-h'])).toMatchObject({ help: true });
    expect(parseArgs(['-v'])).toMatchObject({ version: true });
  });

  it('throws on missing value for non-boolean flag', () => {
    expect(() => parseArgs(['--project'])).toThrow('Missing value for --project');
  });

  it('parses --dry-run and --no-post as booleans', () => {
    expect(parseArgs(['--dry-run', '--no-post'])).toMatchObject({
      dryRun: true,
      noPost: true,
    });
  });
});

describe('diagnostics_channel instrumentation', () => {
  const diagnosticConfig: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'tok',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'anthropic/claude-sonnet-4-5',
    minSeverity: 'info',
    apiKey: 'key',
    reviewFile: 'pi-review.md',
    output: 'review-comments.json',
    dryRun: true,
    noPost: false,
    cwd: '/tmp',
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
  });
});

describe('dry-run and no-post flags', () => {
  it('resolveConfig sets dryRun from --dry-run', () => {
    const cfg = resolveConfig([
      '--dry-run',
      '--project',
      'p',
      '--mr',
      '1',
      '--gitlab-url',
      'https://gl.example.com',
      '--gitlab-token',
      't',
      '--api-key',
      'k',
    ]);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.noPost).toBe(false);
  });

  it('resolveConfig sets noPost from --no-post', () => {
    const cfg = resolveConfig([
      '--no-post',
      '--project',
      'p',
      '--mr',
      '1',
      '--gitlab-url',
      'https://gl.example.com',
      '--gitlab-token',
      't',
      '--api-key',
      'k',
    ]);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.noPost).toBe(true);
  });
});
