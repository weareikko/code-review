/**
 * Run one agent to completion and return its final assistant text.
 *
 * `agent.prompt()` resolves to void — the final text and the usage only arrive
 * on the event stream — so both are collected from `subscribe`, the way
 * `runAgentToCompletion` does in src/gitlab-review.ts. Shared by the eval's
 * replayed Verify arm and the finding-correctness judge, which both need to
 * drive a read-only agent over a materialized checkout.
 */
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool, AssistantMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { createReadOnlyTools } from '@earendil-works/pi-coding-agent';
import { resolveProviderApiKey } from '../../src/config.js';
import { createReviewStreamFn, extractLastAssistantText } from '../../src/gitlab-review.js';
import type { ThinkingLevel } from '../../src/types.js';

export interface AgentRunResult {
  text: string;
  cost: number;
  toolCalls: number;
  latencyMs: number;
  error?: string;
}

export interface AgentRunOptions {
  systemPrompt: string;
  userPrompt: string;
  /** `provider/model-id`, e.g. `openrouter/openai/gpt-5.6-luna`. */
  model: string;
  /** Repo to expose through read-only tools. Omit for a tool-less run. */
  repoDir?: string;
  thinkingLevel?: ThinkingLevel;
}

export function resolveEvalModel(id: string): Model<string> {
  const [provider, ...rest] = id.split('/');
  const model = getBuiltinModel(provider as never, rest.join('/') as never) as
    | Model<string>
    | undefined;
  if (!model) throw new Error(`could not resolve model ${id}`);
  return model;
}

export async function runAgentForText(options: AgentRunOptions): Promise<AgentRunResult> {
  const started = Date.now();
  let cost = 0;
  let toolCalls = 0;

  try {
    const key = resolveProviderApiKey(options.model);
    const agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: resolveEvalModel(options.model),
        tools: (options.repoDir ? createReadOnlyTools(options.repoDir) : []) as AgentTool[],
        thinkingLevel: options.thinkingLevel ?? 'low',
      },
      getApiKey: async () => key,
      streamFn: createReviewStreamFn(),
    });

    const collected: AssistantMessage[] = [];
    let text = '';
    let agentError: string | undefined;

    const ended = new Promise<void>((resolvePromise) => {
      agent.subscribe((event) => {
        if (event.type === 'tool_execution_start') toolCalls += 1;
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const assistant = event.message as AssistantMessage;
          collected.push(assistant);
          cost += assistant.usage?.cost?.total ?? 0;
        }
        if (event.type !== 'agent_end') return;
        const messages = event.messages.filter(
          (m): m is AssistantMessage => m.role === 'assistant',
        );
        const last = messages[messages.length - 1];
        if (last?.stopReason === 'error' || last?.errorMessage) {
          agentError = last.errorMessage ?? 'unknown agent error';
        } else {
          text = extractLastAssistantText(collected.length > 0 ? collected : messages);
        }
        resolvePromise();
      });
    });

    await agent.prompt(options.userPrompt);
    await ended;

    const latencyMs = Date.now() - started;
    if (agentError) return { text: '', cost, toolCalls, latencyMs, error: agentError };
    if (!text) {
      return { text: '', cost, toolCalls, latencyMs, error: 'agent returned an empty response' };
    }
    return { text, cost, toolCalls, latencyMs };
  } catch (err) {
    return {
      text: '',
      cost,
      toolCalls,
      latencyMs: Date.now() - started,
      error: (err as Error).message,
    };
  }
}
