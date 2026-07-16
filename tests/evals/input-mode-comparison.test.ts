import { rm } from 'node:fs/promises';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentLike, CreateAgent } from '../../src/gitlab-review.js';
import { ARMS, runArm } from './input-mode-comparison.js';
import { materializeRepo, type MaterializedRepo } from './materialize.js';
import { generateSyntheticReview, type SyntheticReview } from './synthetic.js';

// End-to-end wiring test for the comparison harness with a STUB agent — no LLM,
// no network. Proves every arm runs, the scorer produces per-bug numbers, disk
// read-coverage is measured, and commit-exploration arms get the git tools wired
// into the agent toolbox. The real (paid) matrix lives in the .eval.ts sibling.

// A model that resolves offline (no provider key / gateway needed); the stub
// agent never calls it, but runReview still builds the model pool.
const M = 'anthropic/claude-sonnet-4-5';

function makeAssistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'stub',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}

/**
 * A stub agent that "finds" every planted bug at its exact location and emits a
 * read event for each bug file plus a git_show, so recall, read-coverage, and
 * git-tool wiring can all be asserted. Captures the tool names it was given.
 */
function makeStub(review: SyntheticReview): { createAgent: CreateAgent; toolNames: string[] } {
  const toolNames: string[] = [];
  const createAgent: CreateAgent = (params) => {
    toolNames.length = 0;
    for (const tool of params.tools) toolNames.push((tool as { name: string }).name);
    // Real agents fan out to multiple subscribers (telemetry + the message
    // collector both subscribe); a single-listener stub would drop the
    // trajectory subscription and lose read-coverage events.
    const listeners: ((event: AgentEvent) => void | Promise<void>)[] = [];
    const emit = async (event: AgentEvent) => {
      for (const l of listeners) await l(event);
    };
    const agent: AgentLike = {
      subscribe(fn) {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      async prompt() {
        for (const bug of review.groundTruth) {
          await emit({
            type: 'tool_execution_start',
            toolName: 'read',
            args: { path: bug.file },
          } as AgentEvent);
        }
        await emit({
          type: 'tool_execution_start',
          toolName: 'git_show',
          args: { ref: 'HEAD' },
        } as AgentEvent);
        const json = JSON.stringify({
          summary: '**Risk: High** — stub.',
          comments: review.groundTruth.map((b) => ({
            file: b.file,
            line: b.line,
            side: 'RIGHT',
            severity: b.severity,
            confidence: 'high',
            body: `issue (blocking): ${b.description}`,
          })),
        });
        const message = makeAssistant(json);
        await emit({ type: 'message_end', message } as AgentEvent);
        await emit({ type: 'agent_end', messages: [message] } as AgentEvent);
      },
    };
    return agent;
  };
  return { createAgent, toolNames };
}

describe('input-mode comparison harness (stub agent)', () => {
  let review: SyntheticReview;
  let repo: MaterializedRepo;

  beforeAll(async () => {
    review = generateSyntheticReview({
      fillerFiles: 5,
      fillerLinesPerFile: 30,
      bugs: ['sql-injection', 'missing-await-loop', 'missing-authz'],
      commits: 3,
    });
    repo = await materializeRepo(review);
  });

  afterAll(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  it('runs every arm and scores full recall when the stub finds every bug', async () => {
    for (const arm of ARMS.filter((a) => !a.incremental)) {
      const { createAgent } = makeStub(review);
      const result = await runArm({ review, arm, repo, createAgent, model: M });
      expect(result.arm).toBe(arm.label);
      expect(result.score.totalBugs).toBe(3);
      expect(result.score.recall).toBe(1);
      expect(result.score.precision).toBe(1);
    }
  });

  it('wires the git tools into the agent only for commit-exploration arms', async () => {
    const inlineStub = makeStub(review);
    await runArm({ review, arm: ARMS[0], repo, createAgent: inlineStub.createAgent, model: M });
    expect(inlineStub.toolNames).not.toContain('git_show');

    const commitsStub = makeStub(review);
    await runArm({
      review,
      arm: ARMS.find((a) => a.label === 'commits-full')!,
      repo,
      createAgent: commitsStub.createAgent,
      model: M,
    });
    expect(commitsStub.toolNames).toEqual(
      expect.arrayContaining(['git_log', 'git_show', 'git_diff']),
    );
  });

  it('measures disk read-coverage from the staged reads', async () => {
    const { createAgent } = makeStub(review);
    const result = await runArm({
      review,
      arm: ARMS.find((a) => a.label === 'disk')!,
      repo,
      createAgent,
      model: M,
    });
    expect(result.score.readCoverage?.bugFileCoverage).toBe(1);
    expect(result.gitToolCalls).toBe(1); // the stub's single git_show event
  });

  it('restricts ground truth to in-scope commits for the incremental arm', async () => {
    const { createAgent } = makeStub(review);
    const result = await runArm({
      review,
      arm: ARMS.find((a) => a.label === 'commits-incremental')!,
      repo,
      createAgent,
      model: M,
    });
    // Fewer bugs are in scope than the full set (commit 0 is "already reviewed").
    expect(result.score.totalBugs).toBeLessThan(3);
    expect(result.score.totalBugs).toBeGreaterThan(0);
  });
});
