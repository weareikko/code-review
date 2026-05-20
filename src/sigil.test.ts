import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSigilEnabled, startSigilBridge } from './sigil.js';

// ---------------------------------------------------------------------------
// Fake sigil-pi factory — records events dispatched through the event bus.
// ---------------------------------------------------------------------------

interface DispatchedEvent {
  event: string;
  data: unknown;
  sessionId: string | undefined;
}

let dispatchedEvents: DispatchedEvent[] = [];

/**
 * A fake `@grafana/sigil-pi` factory that:
 *   - Registers handlers via `pi.on(event, handler)`
 *   - Records dispatched (event, sessionId) pairs so tests can assert behavior
 */
function createFakeSigilPiFactory() {
  return (pi: {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => void;
  }) => {
    const registerSpy = (event: string) => {
      pi.on(event, async (data, ctx) => {
        const sessionId = (
          ctx as { sessionManager: { getSessionId(): string | undefined } }
        ).sessionManager.getSessionId();
        dispatchedEvents.push({ event, data, sessionId });
      });
    };
    for (const evt of [
      'session_start',
      'session_shutdown',
      'turn_start',
      'turn_end',
      'tool_execution_start',
      'tool_execution_end',
      'message_update',
      'message_end',
      'agent_end',
    ]) {
      registerSpy(evt);
    }
  };
}

vi.mock('@grafana/sigil-pi', () => ({ default: createFakeSigilPiFactory() }));

// ---------------------------------------------------------------------------
// Minimal AgentLike for tests.
// ---------------------------------------------------------------------------

type AgentListener = (event: { type: string; [key: string]: unknown }) => Promise<void> | void;

function makeAgent() {
  const listeners: AgentListener[] = [];
  return {
    subscribe(listener: AgentListener): () => void {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
    async emit(event: { type: string; [key: string]: unknown }) {
      for (const l of listeners) await l(event);
    },
    listenerCount(): number {
      return listeners.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const enabledEnv = { GITLAB_REVIEW_SIGIL: '1' };

describe('isSigilEnabled', () => {
  it('returns true when GITLAB_REVIEW_SIGIL=1', () => {
    expect(isSigilEnabled({ GITLAB_REVIEW_SIGIL: '1' })).toBe(true);
  });

  it('returns true when GITLAB_REVIEW_SIGIL=true', () => {
    expect(isSigilEnabled({ GITLAB_REVIEW_SIGIL: 'true' })).toBe(true);
  });

  it('returns false when env var is absent', () => {
    expect(isSigilEnabled({})).toBe(false);
  });

  it('returns false when GITLAB_REVIEW_SIGIL=0', () => {
    expect(isSigilEnabled({ GITLAB_REVIEW_SIGIL: '0' })).toBe(false);
  });
});

describe('startSigilBridge', () => {
  beforeEach(() => {
    dispatchedEvents = [];
  });

  it('returns null when GITLAB_REVIEW_SIGIL is not set', async () => {
    const bridge = await startSigilBridge({ env: {} });
    expect(bridge).toBeNull();
  });

  it('dispatches session_start after successful factory load', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    expect(bridge).not.toBeNull();
    const sessionStarts = dispatchedEvents.filter((e) => e.event === 'session_start');
    expect(sessionStarts).toHaveLength(1);
    expect(sessionStarts[0].sessionId).toBeUndefined();
  });

  it('dispatches session_shutdown on bridge.shutdown()', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    await bridge!.shutdown();
    const shutdowns = dispatchedEvents.filter((e) => e.event === 'session_shutdown');
    expect(shutdowns).toHaveLength(1);
  });

  it('injects SIGIL_AGENT_NAME when not already set', async () => {
    const prev = process.env.SIGIL_AGENT_NAME;
    delete process.env.SIGIL_AGENT_NAME;
    try {
      await startSigilBridge({ env: enabledEnv });
      expect(process.env.SIGIL_AGENT_NAME).toBe('gitlab-review');
    } finally {
      if (prev !== undefined) process.env.SIGIL_AGENT_NAME = prev;
      else delete process.env.SIGIL_AGENT_NAME;
    }
  });

  it('does not overwrite an existing SIGIL_AGENT_NAME', async () => {
    const prev = process.env.SIGIL_AGENT_NAME;
    process.env.SIGIL_AGENT_NAME = 'custom-agent';
    try {
      await startSigilBridge({ env: enabledEnv });
      expect(process.env.SIGIL_AGENT_NAME).toBe('custom-agent');
    } finally {
      if (prev !== undefined) process.env.SIGIL_AGENT_NAME = prev;
      else delete process.env.SIGIL_AGENT_NAME;
    }
  });

  it('injects captureMode into SIGIL_CONTENT_CAPTURE_MODE when not set', async () => {
    const prev = process.env.SIGIL_CONTENT_CAPTURE_MODE;
    delete process.env.SIGIL_CONTENT_CAPTURE_MODE;
    try {
      await startSigilBridge({ env: enabledEnv, captureMode: 'full' });
      expect(process.env.SIGIL_CONTENT_CAPTURE_MODE).toBe('full');
    } finally {
      if (prev !== undefined) process.env.SIGIL_CONTENT_CAPTURE_MODE = prev;
      else delete process.env.SIGIL_CONTENT_CAPTURE_MODE;
    }
  });

  it('does not overwrite an existing SIGIL_CONTENT_CAPTURE_MODE', async () => {
    const prev = process.env.SIGIL_CONTENT_CAPTURE_MODE;
    process.env.SIGIL_CONTENT_CAPTURE_MODE = 'no_tool_content';
    try {
      await startSigilBridge({ env: enabledEnv, captureMode: 'full' });
      expect(process.env.SIGIL_CONTENT_CAPTURE_MODE).toBe('no_tool_content');
    } finally {
      if (prev !== undefined) process.env.SIGIL_CONTENT_CAPTURE_MODE = prev;
      else delete process.env.SIGIL_CONTENT_CAPTURE_MODE;
    }
  });
});

describe('subscribeToAgent', () => {
  beforeEach(() => {
    dispatchedEvents = [];
  });

  it('forwards agent events to sigil-pi handlers in real time', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    const agent = makeAgent();
    const unsubscribe = bridge!.subscribeToAgent(agent, 'run-123');

    await agent.emit({ type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

    const turnStarts = dispatchedEvents.filter((e) => e.event === 'turn_start');
    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0].data).toMatchObject({ type: 'turn_start', turnIndex: 1 });
    unsubscribe();
  });

  it('passes conversationId via ctx.sessionManager.getSessionId()', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    const agent = makeAgent();
    const unsubscribe = bridge!.subscribeToAgent(agent, 'my-run-id');

    await agent.emit({ type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

    const turnStart = dispatchedEvents.find((e) => e.event === 'turn_start');
    expect(turnStart?.sessionId).toBe('my-run-id');
    unsubscribe();
  });

  it('unsubscribing stops event forwarding', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    const agent = makeAgent();
    const unsubscribe = bridge!.subscribeToAgent(agent, 'run-xyz');
    unsubscribe();

    await agent.emit({ type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

    expect(dispatchedEvents.filter((e) => e.event === 'turn_start')).toHaveLength(0);
  });

  it('forwards tool_execution_start and tool_execution_end', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    const agent = makeAgent();
    const unsubscribe = bridge!.subscribeToAgent(agent, 'run-tools');

    await agent.emit({
      type: 'tool_execution_start',
      toolCallId: 'tc-1',
      toolName: 'Read',
      args: { file_path: 'foo.ts' },
    });
    await agent.emit({
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'Read',
      result: 'content',
      isError: false,
    });

    expect(dispatchedEvents.some((e) => e.event === 'tool_execution_start')).toBe(true);
    expect(dispatchedEvents.some((e) => e.event === 'tool_execution_end')).toBe(true);
    unsubscribe();
  });

  it('forwards message_update events (TTFT)', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    const agent = makeAgent();
    const unsubscribe = bridge!.subscribeToAgent(agent, 'run-ttft');

    await agent.emit({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: {},
    });

    expect(dispatchedEvents.some((e) => e.event === 'message_update')).toBe(true);
    unsubscribe();
  });

  it('forwards turn_end with assistant message and toolResults', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    const agent = makeAgent();
    const unsubscribe = bridge!.subscribeToAgent(agent, 'run-end');

    const fakeMsg = {
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'OK' }],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    await agent.emit({ type: 'turn_end', turnIndex: 1, message: fakeMsg, toolResults: [] });

    const turnEnds = dispatchedEvents.filter((e) => e.event === 'turn_end');
    expect(turnEnds).toHaveLength(1);
    expect((turnEnds[0].data as { message: unknown }).message).toEqual(fakeMsg);
    unsubscribe();
  });

  it('handles multiple concurrent subscriptions with different conversationIds', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    const agent = makeAgent();
    const unsub1 = bridge!.subscribeToAgent(agent, 'run-A');
    const unsub2 = bridge!.subscribeToAgent(agent, 'run-B');

    await agent.emit({ type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

    const turnStarts = dispatchedEvents.filter((e) => e.event === 'turn_start');
    expect(turnStarts).toHaveLength(2);
    expect(
      turnStarts.map((e) => e.sessionId).toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(['run-A', 'run-B']);

    unsub1();
    unsub2();
  });

  it('works with undefined conversationId', async () => {
    const bridge = await startSigilBridge({ env: enabledEnv });
    const agent = makeAgent();
    const unsubscribe = bridge!.subscribeToAgent(agent, undefined);

    await agent.emit({ type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

    const turnStart = dispatchedEvents.find((e) => e.event === 'turn_start');
    expect(turnStart?.sessionId).toBeUndefined();
    unsubscribe();
  });
});
