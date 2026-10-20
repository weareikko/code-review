import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AgentLike } from '../../src/gitlab-review.js';

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type Trajectory = {
  turns: number;
  toolCalls: ToolCall[];
};

export function createTrajectoryCollector(): {
  trajectory: Trajectory;
  attach: (agent: AgentLike) => () => void;
} {
  const trajectory: Trajectory = { turns: 0, toolCalls: [] };
  return {
    trajectory,
    attach: (agent) => {
      return agent.subscribe((event: AgentEvent) => {
        if (event.type === 'turn_start') trajectory.turns += 1;
        if (event.type === 'tool_execution_start') {
          const args = (event.args && typeof event.args === 'object' ? event.args : {}) as Record<
            string,
            unknown
          >;
          trajectory.toolCalls.push({ name: event.toolName, args });
        }
      });
    },
  };
}

export function filesRead(trajectory: Trajectory): string[] {
  // pi-coding-agent's read tool uses `path`; other harnesses use `file_path`.
  // Accept both so trajectory consumers don't silently miss reads.
  const paths = new Set<string>();
  for (const call of trajectory.toolCalls) {
    if (call.name !== 'Read' && call.name !== 'read') continue;
    const candidate = call.args.path ?? call.args.file_path;
    if (typeof candidate === 'string') paths.add(candidate);
  }
  return [...paths];
}

export function bashCommands(trajectory: Trajectory): string[] {
  const out: string[] = [];
  for (const call of trajectory.toolCalls) {
    if (call.name !== 'Bash' && call.name !== 'bash') continue;
    const cmd = call.args.command;
    if (typeof cmd === 'string') out.push(cmd);
  }
  return out;
}
