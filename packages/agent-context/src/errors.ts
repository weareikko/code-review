export type AgentContextErrorCode = 'CONFIG_ERROR' | 'GIT_ERROR';

export interface AgentContextErrorOptions extends ErrorOptions {
  code: AgentContextErrorCode;
  /** An actionable next step for the operator. Never holds a secret. */
  hint?: string;
}

/** Base class of the errors this package throws. */
export class AgentContextError extends Error {
  readonly code: AgentContextErrorCode;
  readonly hint?: string;

  constructor(message: string, options: AgentContextErrorOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.hint = options.hint;
  }
}

/** A skill, marketplace or MCP spec that cannot be parsed or resolved. */
export class ConfigError extends AgentContextError {
  constructor(message: string, options: Omit<AgentContextErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'CONFIG_ERROR' });
  }
}

/** A `git` command that failed. `hint` holds its output. */
export class GitError extends AgentContextError {
  constructor(message: string, options: Omit<AgentContextErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'GIT_ERROR' });
  }
}

/** `[CODE] message` plus the hint on a second line, or the plain message. */
export function formatError(error: unknown): string {
  if (error instanceof AgentContextError) {
    const lines = [`[${error.code}] ${error.message}`];
    if (error.hint) lines.push(`Hint: ${error.hint}`);
    return lines.join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}
