export type ErrorCode =
  | 'CONFIG_ERROR'
  | 'GITLAB_API_ERROR'
  | 'GIT_ERROR'
  | 'REVIEWER_ERROR'
  | 'PARSE_ERROR'
  | 'RUNTIME_ERROR';

export interface GitlabReviewErrorOptions extends ErrorOptions {
  code: ErrorCode;
  hint?: string;
}

export class GitlabReviewError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(message: string, options: GitlabReviewErrorOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.hint = options.hint;
  }
}

export class ConfigError extends GitlabReviewError {
  constructor(message: string, options: Omit<GitlabReviewErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'CONFIG_ERROR' });
  }
}

export class GitLabApiError extends GitlabReviewError {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly responseBody?: string;

  constructor(
    message: string,
    options: Omit<GitlabReviewErrorOptions, 'code'> & {
      method: string;
      path: string;
      status?: number;
      responseBody?: string;
    },
  ) {
    super(message, { ...options, code: 'GITLAB_API_ERROR' });
    this.method = options.method;
    this.path = options.path;
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

export class GitError extends GitlabReviewError {
  constructor(message: string, options: Omit<GitlabReviewErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'GIT_ERROR' });
  }
}

export class ReviewerError extends GitlabReviewError {
  constructor(message: string, options: Omit<GitlabReviewErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'REVIEWER_ERROR' });
  }
}

export class RuntimeError extends GitlabReviewError {
  constructor(message: string, options: Omit<GitlabReviewErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'RUNTIME_ERROR' });
  }
}

export function formatError(error: unknown): string {
  if (error instanceof GitlabReviewError) {
    const lines = [`[${error.code}] ${error.message}`];
    if (error.hint) lines.push(`Hint: ${error.hint}`);
    if (error instanceof GitLabApiError && error.responseBody) {
      lines.push(`Response: ${error.responseBody}`);
    }
    return lines.join('\n');
  }

  return error instanceof Error ? error.message : String(error);
}
