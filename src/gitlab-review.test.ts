import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { ReviewerError } from './errors.js';
import {
  buildJSONSystemPrompt,
  buildUserPrompt,
  filterDiff,
  loadReviewContext,
  runReview,
  type AgentLike,
} from './gitlab-review.js';
import { noopLogger, type Logger } from './logger.js';
import type { Skill } from './skills.js';

describe('runReview pipeline', () => {
  const minimalConfig: Config = {
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
    baseUrl: '',
    maxTokens: 0,
    reviewFile: 'gitlab-review.md',
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

  const sampleDiff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    ' line1',
    '+added',
    ' line2',
    '',
  ].join('\n');

  function makeAssistant(
    text: string,
    usage: Partial<AssistantMessage['usage']> & {
      cost?: Partial<AssistantMessage['usage']['cost']>;
    } = {},
  ): AssistantMessage {
    return {
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        totalTokens:
          usage.totalTokens ??
          (usage.input ?? 0) +
            (usage.output ?? 0) +
            (usage.cacheRead ?? 0) +
            (usage.cacheWrite ?? 0),
        cost: {
          input: usage.cost?.input ?? 0,
          output: usage.cost?.output ?? 0,
          cacheRead: usage.cost?.cacheRead ?? 0,
          cacheWrite: usage.cost?.cacheWrite ?? 0,
          total: usage.cost?.total ?? 0,
        },
      },
    } as AssistantMessage;
  }

  function fakeAgent(messages: AssistantMessage[]): AgentLike {
    let listener: ((event: AgentEvent) => void | Promise<void>) | undefined;
    return {
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        if (!listener) return;
        for (const message of messages) {
          await listener({ type: 'message_end', message });
        }
        await listener({ type: 'agent_end', messages });
      },
    };
  }

  it('filterDiff drops noise files and reports them as skipped', () => {
    const noisy = [
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    const result = filterDiff(noisy);
    expect(result.skippedFiles).toEqual(['package-lock.json']);
    expect(result.diff).toContain('src/a.ts');
    expect(result.diff).not.toContain('package-lock.json');
  });

  it('accumulates usage across multiple assistant messages and writes gitlab-review.md', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const messages = [
      makeAssistant('partial thought', {
        input: 100,
        output: 25,
        cacheRead: 10,
        cacheWrite: 5,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
      }),
      makeAssistant('Final review summary.', {
        input: 50,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.0005, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.0035 },
      }),
    ];

    const usage = await runReview(
      { ...minimalConfig, cwd },
      {
        cwd,
        diff: sampleDiff,
        createAgent: () => fakeAgent(messages),
      },
    );

    expect(usage.model).toBe('anthropic/claude-sonnet-4-5');
    expect(usage.tokens).toEqual({
      input: 150,
      output: 65,
      cacheRead: 10,
      cacheWrite: 5,
      total: 230,
    });
    expect(usage.cost.input).toBeCloseTo(0.0015, 10);
    expect(usage.cost.output).toBeCloseTo(0.005, 10);
    expect(usage.cost.cacheRead).toBeCloseTo(0.0001, 10);
    expect(usage.cost.cacheWrite).toBeCloseTo(0.0002, 10);
    expect(usage.cost.total).toBeCloseTo(0.0068, 10);

    const written = await readFile(join(cwd, 'gitlab-review.md'), 'utf8');
    expect(written).toBe('Final review summary.');
  });

  it('passes the systemPrompt with minSeverity rule and tools scoped to cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured = vi.fn();
    const messages = [makeAssistant('ok', { input: 1, output: 1 })];

    await runReview(
      { ...minimalConfig, cwd, minSeverity: 'warn' },
      {
        cwd,
        diff: sampleDiff,
        createAgent: (params) => {
          captured(params);
          return fakeAgent(messages);
        },
      },
    );

    expect(captured).toHaveBeenCalledTimes(1);
    const params = captured.mock.calls[0][0];
    expect(params.systemPrompt).toContain('Only report CRITICAL and WARN issues');
    expect(Array.isArray(params.tools)).toBe(true);
    expect(params.tools.length).toBeGreaterThan(0);
    expect(params.thinkingLevel).toBe('off');
  });

  it('forwards config.thinkingLevel to the agent factory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured = vi.fn();
    const messages = [makeAssistant('ok', { input: 1, output: 1 })];

    await runReview(
      { ...minimalConfig, cwd, thinkingLevel: 'high' },
      {
        cwd,
        diff: sampleDiff,
        createAgent: (params) => {
          captured(params);
          return fakeAgent(messages);
        },
      },
    );

    expect(captured.mock.calls[0][0].thinkingLevel).toBe('high');
  });

  it('throws ReviewerError when the agent returns no text', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const messages = [makeAssistant('', { input: 1, output: 0 })];

    await expect(
      runReview(
        { ...minimalConfig, cwd },
        {
          cwd,
          diff: sampleDiff,
          createAgent: () => fakeAgent(messages),
        },
      ),
    ).rejects.toBeInstanceOf(ReviewerError);
  });

  it('emits turn_start and tool_execution_start debug lines to the logger', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const messages = [makeAssistant('Done.', { input: 1, output: 1 })];
    const debugLines: string[] = [];
    const logger: Logger = {
      ...noopLogger,
      debug: (msg) => {
        debugLines.push(msg);
      },
    };

    let listener: ((event: AgentEvent) => void | Promise<void>) | undefined;
    const agent: AgentLike = {
      subscribe(fn) {
        listener = fn;
        return () => {};
      },
      async prompt() {
        if (!listener) return;
        await listener({ type: 'turn_start' });
        await listener({
          type: 'tool_execution_start',
          toolCallId: 'id1',
          toolName: 'Read',
          args: { file_path: 'src/auth.ts' },
        });
        await listener({
          type: 'tool_execution_start',
          toolCallId: 'id2',
          toolName: 'Bash',
          args: { command: 'grep -n foo src/auth.ts' },
        });
        await listener({
          type: 'tool_execution_start',
          toolCallId: 'id3',
          toolName: 'Glob',
          args: { pattern: '**/*.ts', cwd: '/tmp' },
        });
        await listener({ type: 'message_end', message: messages[0] });
        await listener({ type: 'agent_end', messages });
      },
    };

    await runReview(
      { ...minimalConfig, cwd },
      { cwd, diff: sampleDiff, createAgent: () => agent, logger },
    );

    expect(debugLines.some((l) => l.startsWith('Turn 1 started'))).toBe(true);
    expect(debugLines.some((l) => l.includes('Read') && l.includes('src/auth.ts'))).toBe(true);
    expect(debugLines.some((l) => l.includes('Bash') && l.includes('grep -n foo'))).toBe(true);
    expect(debugLines.some((l) => l.includes('Glob') && l.includes('pattern=**/*.ts'))).toBe(true);
    expect(debugLines.some((l) => l.startsWith('Agent finished: 1 turn(s), 3 tool call(s)'))).toBe(
      true,
    );
  });

  it('counts multiple turns and tool calls correctly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const msg1 = makeAssistant('', { input: 1, output: 1 });
    const msg2 = makeAssistant('Final.', { input: 1, output: 1 });
    const debugLines: string[] = [];
    const logger: Logger = {
      ...noopLogger,
      debug: (msg) => {
        debugLines.push(msg);
      },
    };

    let listener: ((event: AgentEvent) => void | Promise<void>) | undefined;
    const agent: AgentLike = {
      subscribe(fn) {
        listener = fn;
        return () => {};
      },
      async prompt() {
        if (!listener) return;
        await listener({ type: 'turn_start' });
        await listener({
          type: 'tool_execution_start',
          toolCallId: 'a',
          toolName: 'Read',
          args: { file_path: 'x.ts' },
        });
        await listener({ type: 'message_end', message: msg1 });
        await listener({ type: 'turn_start' });
        await listener({ type: 'message_end', message: msg2 });
        await listener({ type: 'agent_end', messages: [msg1, msg2] });
      },
    };

    await runReview(
      { ...minimalConfig, cwd },
      { cwd, diff: sampleDiff, createAgent: () => agent, logger },
    );

    expect(debugLines.filter((l) => l.startsWith('Turn'))).toHaveLength(2);
    expect(debugLines.some((l) => l.includes('2 turn(s), 1 tool call(s)'))).toBe(true);
  });

  it('uses noopLogger when no logger is provided', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const messages = [makeAssistant('ok.', { input: 1, output: 1 })];
    await expect(
      runReview(
        { ...minimalConfig, cwd },
        { cwd, diff: sampleDiff, createAgent: () => fakeAgent(messages) },
      ),
    ).resolves.toBeDefined();
  });
});

describe('resolveModel (via runReview createAgent)', () => {
  const sampleDiff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');

  function makeAssistant(text: string): AssistantMessage {
    return {
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test',
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as AssistantMessage;
  }

  function fakeAgentWithCapture(
    captured: { model?: unknown },
    text = 'ok',
  ): (params: { model: unknown }) => AgentLike {
    return (params) => {
      captured.model = params.model;
      const msg = makeAssistant(text);
      let listener: ((event: AgentEvent) => void | Promise<void>) | undefined;
      return {
        subscribe(fn) {
          listener = fn;
          return () => {};
        },
        async prompt() {
          if (!listener) return;
          await listener({ type: 'message_end', message: msg });
          await listener({ type: 'agent_end', messages: [msg] });
        },
      };
    };
  }

  const base: Config = {
    project: 'proj',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'tok',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    model: 'ollama/llama3:8b',
    minSeverity: 'info',
    thinkingLevel: 'off',
    postingMode: 'direct',
    apiKey: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    maxTokens: 0,
    reviewFile: 'gitlab-review.md',
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

  it('builds an openai-completions model for ollama provider', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured: { model?: unknown } = {};

    await runReview(
      { ...base, cwd },
      { cwd, diff: sampleDiff, createAgent: fakeAgentWithCapture(captured) },
    );

    expect(captured.model).toMatchObject({
      id: 'llama3:8b',
      api: 'openai-completions',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      reasoning: false,
    });
  });

  it('uses custom baseUrl for ollama model from config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured: { model?: unknown } = {};

    await runReview(
      { ...base, cwd, baseUrl: 'http://ollama.internal:11434/v1' },
      { cwd, diff: sampleDiff, createAgent: fakeAgentWithCapture(captured) },
    );

    expect((captured.model as { baseUrl?: string })?.baseUrl).toBe(
      'http://ollama.internal:11434/v1',
    );
  });

  it('applies maxTokens to the ollama model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured: { model?: unknown } = {};

    await runReview(
      { ...base, cwd, maxTokens: 2048 },
      { cwd, diff: sampleDiff, createAgent: fakeAgentWithCapture(captured) },
    );

    expect((captured.model as { maxTokens?: number })?.maxTokens).toBe(2048);
  });

  it('uses model id with slash for openrouter multi-slash models', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured: { model?: unknown } = {};

    // openrouter/ai21/jamba-large-1.7 is a registered model in pi-ai
    await runReview(
      { ...base, cwd, model: 'openrouter/ai21/jamba-large-1.7', apiKey: 'or-key' },
      { cwd, diff: sampleDiff, createAgent: fakeAgentWithCapture(captured) },
    );

    // The model ID passed to the agent should be the full multi-slash ID
    expect((captured.model as { id?: string })?.id).toBe('ai21/jamba-large-1.7');
    expect((captured.model as { provider?: string })?.provider).toBe('openrouter');
  });

  it('throws ReviewerError for an unknown model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));

    await expect(
      runReview(
        { ...base, cwd, model: 'anthropic/does-not-exist-9999' },
        { cwd, diff: sampleDiff, createAgent: fakeAgentWithCapture({}) },
      ),
    ).rejects.toBeInstanceOf(ReviewerError);
  });

  it('throws ReviewerError when model string has no slash', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));

    await expect(
      runReview(
        { ...base, cwd, model: 'noslash' },
        { cwd, diff: sampleDiff, createAgent: fakeAgentWithCapture({}) },
      ),
    ).rejects.toBeInstanceOf(ReviewerError);
  });

  it('applies baseUrl override to a registered non-Ollama model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured: { model?: unknown } = {};

    await runReview(
      {
        ...base,
        cwd,
        model: 'openrouter/ai21/jamba-large-1.7',
        apiKey: 'or-key',
        baseUrl: 'https://custom-gateway.example.com/v1',
      },
      { cwd, diff: sampleDiff, createAgent: fakeAgentWithCapture(captured) },
    );

    expect((captured.model as { baseUrl?: string })?.baseUrl).toBe(
      'https://custom-gateway.example.com/v1',
    );
  });

  it('applies maxTokens override to a registered non-Ollama model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured: { model?: unknown } = {};

    await runReview(
      {
        ...base,
        cwd,
        model: 'openrouter/ai21/jamba-large-1.7',
        apiKey: 'or-key',
        maxTokens: 1024,
      },
      { cwd, diff: sampleDiff, createAgent: fakeAgentWithCapture(captured) },
    );

    expect((captured.model as { maxTokens?: number })?.maxTokens).toBe(1024);
  });

  it('uses contextWindow 131072 for ollama model regardless of maxTokens', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'gitlab-review-'));
    const captured: { model?: unknown } = {};

    await runReview(
      { ...base, cwd, maxTokens: 512 },
      { cwd, diff: sampleDiff, createAgent: fakeAgentWithCapture(captured) },
    );

    expect((captured.model as { contextWindow?: number })?.contextWindow).toBe(131072);
  });
});

function makeTestSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'security',
    description: 'Security review guidelines',
    filePath: '/path/to/skills/security/SKILL.md',
    rootDir: '/path/to/skills/security',
    resourceDirs: [],
    source: 'npm',
    ...overrides,
  };
}

describe('buildJSONSystemPrompt — skill section', () => {
  it('emits <skill_file> path reference instead of inline body', () => {
    const context = {
      conventions: [],
      reviewRules: [],
      skills: [makeTestSkill()],
    };

    const prompt = buildJSONSystemPrompt(context, 'INFO');

    expect(prompt).toContain('<skill_file>/path/to/skills/security/SKILL.md</skill_file>');
  });

  it('does not embed skill body content inline', () => {
    const context = {
      conventions: [],
      reviewRules: [],
      skills: [makeTestSkill({ filePath: '/some/SKILL.md' })],
    };

    const prompt = buildJSONSystemPrompt(context, 'INFO');

    // The prompt should not contain any stale body text
    expect(prompt).not.toContain('## How to review');
  });

  it('includes read-skills preamble in the <skills> block', () => {
    const context = {
      conventions: [],
      reviewRules: [],
      skills: [makeTestSkill()],
    };

    const prompt = buildJSONSystemPrompt(context, 'INFO');

    expect(prompt).toContain('Read each skill file before applying it.');
    expect(prompt).toContain('<skills>');
  });

  it('makes the skill Read instruction mandatory with a worked tool-call example', () => {
    const context = {
      conventions: [],
      reviewRules: [],
      skills: [makeTestSkill()],
    };

    const prompt = buildJSONSystemPrompt(context, 'INFO');

    // The earlier one-line preamble ("Read each skill file before applying
    // it") was too soft — SkillFileReadJudge consistently scored 0 in eval
    // runs because the agent skipped the Read call entirely. The new
    // preamble adds an explicit MUST, a worked Read({ file_path: ... }) tool
    // call, and an explanation that the description alone is not enough.
    expect(prompt).toMatch(/you MUST/);
    expect(prompt).toContain('Read({ file_path:');
    expect(prompt).toMatch(/a no-op/i);
    expect(prompt).toMatch(/description alone is not enough/i);
  });

  it('includes skill name and description', () => {
    const context = {
      conventions: [],
      reviewRules: [],
      skills: [makeTestSkill({ name: 'accessibility', description: 'A11y review rules' })],
    };

    const prompt = buildJSONSystemPrompt(context, 'INFO');

    expect(prompt).toContain('<skill name="accessibility">');
    expect(prompt).toContain('<description>A11y review rules</description>');
  });

  it('includes <skill_resources> block when resourceDirs are present', () => {
    const context = {
      conventions: [],
      reviewRules: [],
      skills: [makeTestSkill({ resourceDirs: ['references'] })],
    };

    const prompt = buildJSONSystemPrompt(context, 'INFO');

    expect(prompt).toContain('<skill_resources>');
    expect(prompt).toContain('references/');
  });

  it('emits no <skills> block when skills list is empty', () => {
    const context = { conventions: [], reviewRules: [], skills: [] };

    const prompt = buildJSONSystemPrompt(context, 'INFO');

    expect(prompt).not.toContain('<skills>');
  });

  describe('format directives', () => {
    const emptyContext = { conventions: [], reviewRules: [], skills: [] };

    it('includes the Conventional Comments format block with label list and severity mapping', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      expect(prompt).toContain('<comment_format>');
      expect(prompt).toContain('conventionalcomments.org');
      expect(prompt).toContain(
        'Allowed labels: issue, suggestion, nitpick, question, todo, chore, note, thought',
      );
      expect(prompt).toContain('Allowed decorations: (blocking), (non-blocking), (if-minor)');
      expect(prompt).toContain('CRITICAL → "issue (blocking): ..."');
      expect(prompt).toContain('WARN     → "issue: ..."');
      expect(prompt).toContain('INFO     → choose the fitting label');
      expect(prompt).toContain('Do NOT emit "praise:" comments');
    });

    it('includes the standardized summary skeleton with an always-present risk line', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      expect(prompt).toContain('<summary_skeleton>');
      expect(prompt).toContain('**Risk: <Low | Medium | High>**');
      expect(prompt).toContain('**<N> issue(s) found:**');
      expect(prompt).toContain('**Notes:**');
      expect(prompt).not.toContain('No issues found in the reviewed diff.');
      expect(prompt).toContain('The risk line and the overview are ALWAYS present');
    });

    it('includes the anti-duplication rule in <rules>', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      expect(prompt).toMatch(/summary lists findings by their Conventional Comment subject only/);
      expect(prompt).toMatch(/MUST NOT repeat the discussion/);
    });

    it('requires literal-text findings (typos, wrong identifiers) to quote the token verbatim', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      // A v0.6.2 review hallucinated a typo ("usePagScreenshot" should be
      // "usePageScreenshot") on a line that actually read `usePageScreenshot`.
      // Claims about the literal text are hallucination-prone; the rule forces
      // a verbatim quote and a re-read before any such finding can stand.
      expect(prompt).toMatch(/literal text of the code/i);
      expect(prompt).toMatch(/quote the offending token verbatim/i);
      expect(prompt).toMatch(/character-for-character/i);
      expect(prompt).toMatch(/the finding is fabricated — drop it/i);
    });

    it('includes the declarative tone rule excluding question and thought labels', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      expect(prompt).toContain('Write declaratively.');
      expect(prompt).toMatch(/question and thought labels are inherently tentative and exempt/);
    });

    it('requires the Notes section to echo suppressed severe findings with their context', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      // Eval runs showed the reviewer silently dropping CRITICAL/WARN findings
      // when commit messages or prior threads justified them, without
      // surfacing the suppression in Notes. Developers had no audit trail of
      // which context the reviewer actually read. The new rule makes the
      // suppression bullet mandatory.
      expect(prompt).toMatch(/suppress(es|ed).*would otherwise be a CRITICAL or WARN finding/i);
      expect(prompt).toMatch(/MUST add a one-line bullet/i);
      expect(prompt).toMatch(/Silent suppression is not acceptable/i);
    });

    it('splits severity (impact) from confidence (certainty) into two separate tier blocks', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      // The earlier rubric conflated impact and certainty into one block,
      // which led to severe over-flagging on uncertain-but-bad-looking code.
      // Now severity carries impact only, confidence carries certainty, and
      // an explicit interaction block governs how they combine.
      expect(prompt).toMatch(/<severity_tiers>/);
      expect(prompt).toMatch(/<confidence_tiers>/);
      expect(prompt).toMatch(/<severity_confidence_interaction>/);
      expect(prompt).toMatch(/Severity reflects the IMPACT/);
      expect(prompt).toMatch(/Confidence reflects how certain/);
      expect(prompt).toMatch(/CRITICAL finding MUST be high confidence/);
      expect(prompt).toMatch(/silence beats fabrication/i);
    });

    it('declares confidence as a required JSON field with three allowed values', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      // The output_format example must include confidence so the model
      // produces it; the field-rules list must mark it required.
      expect(prompt).toContain('"confidence": "high"');
      expect(prompt).toMatch(/confidence: "high" \| "medium" \| "low"/);
      expect(prompt).toMatch(/Required on every comment\./);
    });

    it('drops severity emoji noise from the prompt', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      // Severity tiers no longer carry decorative 🔴/🟡/🔵 emoji — labels alone
      // carry the meaning, and comments now use Conventional Comments labels instead.
      expect(prompt).not.toContain('🔴');
      expect(prompt).not.toContain('🟡');
      expect(prompt).not.toContain('🔵');
    });

    it('includes a worked example showing one issue (blocking) and one nitpick', () => {
      const prompt = buildJSONSystemPrompt(emptyContext, 'INFO');

      expect(prompt).toContain('<example>');
      expect(prompt).toContain('"severity": "CRITICAL"');
      expect(prompt).toContain('"severity": "INFO"');
      expect(prompt).toContain('issue (blocking): Loop runs N+1 attempts');
      expect(prompt).toContain('nitpick: Helper name shadows');
      // Demonstrates a ```suggestion``` block in the example body
      expect(prompt).toContain('```suggestion');
    });
  });

  it('renders multiple skills separated by blank lines', () => {
    const context = {
      conventions: [],
      reviewRules: [],
      skills: [
        makeTestSkill({ name: 'security', filePath: '/skills/security/SKILL.md' }),
        makeTestSkill({ name: 'accessibility', filePath: '/skills/a11y/SKILL.md' }),
      ],
    };

    const prompt = buildJSONSystemPrompt(context, 'INFO');

    expect(prompt).toContain('<skill name="security">');
    expect(prompt).toContain('<skill_file>/skills/security/SKILL.md</skill_file>');
    expect(prompt).toContain('<skill name="accessibility">');
    expect(prompt).toContain('<skill_file>/skills/a11y/SKILL.md</skill_file>');
  });
});

// ---------------------------------------------------------------------------
// buildUserPrompt
// ---------------------------------------------------------------------------

describe('buildUserPrompt', () => {
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n+added';

  it('without commitLog: wraps diff in <diff> and prompts to review', () => {
    const prompt = buildUserPrompt(diff);
    expect(prompt).toContain('Review this diff:');
    expect(prompt).toContain('<diff>');
    expect(prompt).toContain(diff);
    expect(prompt).not.toContain('<commits>');
  });

  it('with commitLog: prepends <commits> section before <diff>', () => {
    const log = 'commit abc123\nAuthor: Dev\nDate: 2025-05-23\n\nfeat: add feature\n';
    const prompt = buildUserPrompt(diff, [], log);

    expect(prompt).toContain('<commits>');
    expect(prompt).toContain(log.trim());
    expect(prompt).toContain('</commits>');
    expect(prompt).toContain('<diff>');

    // commits section must come before the diff section
    expect(prompt.indexOf('<commits>')).toBeLessThan(prompt.indexOf('<diff>'));
  });

  it('with empty or whitespace-only commitLog: omits <commits> section', () => {
    expect(buildUserPrompt(diff, [], '')).not.toContain('<commits>');
    expect(buildUserPrompt(diff, [], '   \n  ')).not.toContain('<commits>');
  });

  it('with skippedFiles: appends <skipped_files> block after <diff>', () => {
    const prompt = buildUserPrompt(diff, ['dist/bundle.js', 'package-lock.json']);
    expect(prompt).toContain('<skipped_files>');
    expect(prompt).toContain('- dist/bundle.js');
    expect(prompt).toContain('- package-lock.json');
    expect(prompt.indexOf('<diff>')).toBeLessThan(prompt.indexOf('<skipped_files>'));
  });

  it('with both commitLog and skippedFiles: order is <commits> → <diff> → <skipped_files>', () => {
    const log = 'commit abc\nAuthor: Dev\nDate: 2025-05-23\n\nfeat: something\n';
    const prompt = buildUserPrompt(diff, ['lock.json'], log);

    const commitsPos = prompt.indexOf('<commits>');
    const diffPos = prompt.indexOf('<diff>');
    const skippedPos = prompt.indexOf('<skipped_files>');

    expect(commitsPos).toBeLessThan(diffPos);
    expect(diffPos).toBeLessThan(skippedPos);
  });

  it('with priorThreads: appends <prior_review_feedback> block after <diff>', () => {
    const threads = [
      {
        file: 'src/a.ts',
        line: 10,
        resolved: false,
        botComment: 'Missing null check.',
        replies: ['Fixed in next commit.'],
      },
    ];
    const prompt = buildUserPrompt(diff, [], undefined, threads);

    expect(prompt).toContain('<prior_review_feedback>');
    expect(prompt).toContain('Missing null check.');
    expect(prompt).toContain('Fixed in next commit.');
    expect(prompt.indexOf('<diff>')).toBeLessThan(prompt.indexOf('<prior_review_feedback>'));
  });

  it('with empty priorThreads array: omits <prior_review_feedback> section', () => {
    const prompt = buildUserPrompt(diff, [], undefined, []);
    expect(prompt).not.toContain('<prior_review_feedback>');
  });

  it('with all sections: order is <commits> → <diff> → <skipped_files> → <prior_review_feedback>', () => {
    const log = 'commit abc\nAuthor: Dev\nDate: 2025-05-23\n\nfeat: x\n';
    const threads = [
      { file: 'src/a.ts', line: 1, resolved: false, botComment: 'Bug.', replies: ['Fixed.'] },
    ];
    const prompt = buildUserPrompt(diff, ['lock.json'], log, threads);

    const commitsPos = prompt.indexOf('<commits>');
    const diffPos = prompt.indexOf('<diff>');
    const skippedPos = prompt.indexOf('<skipped_files>');
    const priorPos = prompt.indexOf('<prior_review_feedback>');

    expect(commitsPos).toBeLessThan(diffPos);
    expect(diffPos).toBeLessThan(skippedPos);
    expect(skippedPos).toBeLessThan(priorPos);
  });

  it('with intent: prepends an <intent> block before <commits> and <diff>', () => {
    const log = 'commit abc\nfeat: x\n';
    const prompt = buildUserPrompt(diff, [], log, undefined, {
      title: 'Add retry helper',
      description: 'Retries failed checkout calls.',
    });

    expect(prompt).toContain('<intent>');
    expect(prompt).toContain('Add retry helper');
    expect(prompt).toContain('Retries failed checkout calls.');
    expect(prompt).toContain('</intent>');
    expect(prompt.indexOf('<intent>')).toBeLessThan(prompt.indexOf('<commits>'));
    expect(prompt.indexOf('<intent>')).toBeLessThan(prompt.indexOf('<diff>'));
  });

  it('with intent title only: renders the title without an empty description', () => {
    const prompt = buildUserPrompt(diff, [], undefined, undefined, {
      title: 'Add retry helper',
    });
    expect(prompt).toContain('<intent>');
    expect(prompt).toContain('Add retry helper');
  });

  it('trims whitespace from the intent title and description', () => {
    const prompt = buildUserPrompt(diff, [], undefined, undefined, {
      title: '  Add retry helper  \n',
      description: '\n\n  Retries failed checkout calls.  \n\n',
    });
    expect(prompt).toContain('Add retry helper');
    expect(prompt).toContain('Retries failed checkout calls.');
    expect(prompt).not.toContain('  Add retry helper  ');
  });

  it('with empty/whitespace intent: omits the <intent> section', () => {
    expect(buildUserPrompt(diff, [], undefined, undefined, {})).not.toContain('<intent>');
    expect(
      buildUserPrompt(diff, [], undefined, undefined, { title: '   ', description: '\n\n' }),
    ).not.toContain('<intent>');
    expect(buildUserPrompt(diff, [], undefined, undefined, undefined)).not.toContain('<intent>');
  });

  it('with all sections: order is <intent> → <commits> → <diff> → <skipped_files> → <prior_review_feedback>', () => {
    const log = 'commit abc\nfeat: x\n';
    const threads = [
      { file: 'src/a.ts', line: 1, resolved: false, botComment: 'Bug.', replies: ['Fixed.'] },
    ];
    const prompt = buildUserPrompt(diff, ['lock.json'], log, threads, {
      title: 'Add retry helper',
      description: 'Retries failed checkout calls.',
    });

    const intentPos = prompt.indexOf('<intent>');
    const commitsPos = prompt.indexOf('<commits>');
    const diffPos = prompt.indexOf('<diff>');
    const skippedPos = prompt.indexOf('<skipped_files>');
    const priorPos = prompt.indexOf('<prior_review_feedback>');

    expect(intentPos).toBeLessThan(commitsPos);
    expect(commitsPos).toBeLessThan(diffPos);
    expect(diffPos).toBeLessThan(skippedPos);
    expect(skippedPos).toBeLessThan(priorPos);
  });
});

describe('loadReviewContext', () => {
  it('loads a named skill and threads refreshGitSkills through to the loader', async () => {
    // Uses the bundled `code-review` skill so no clone/cache is involved — this
    // exercises the named-skill resolution path (and the refreshGitSkills
    // option being forwarded) without touching the filesystem cache. Git-skill
    // cache behaviour is covered hermetically in `skills-git-cache.test.ts`.
    const cwd = await mkdtemp(join(tmpdir(), 'lrc-'));
    const ctx = await loadReviewContext(cwd, ['code-review'], undefined, {
      refreshGitSkills: false,
    });
    expect(ctx.skills.map((s) => s.name)).toContain('code-review');
  });
});
