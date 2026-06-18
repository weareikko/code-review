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
  /**
   * Marks a deadline-exceeded failure. The CLI's `code` taxonomy stays coarse
   * (one code per subsystem), so timeouts are flagged here rather than via a
   * separate code; the OTel bridge reads it to label runs `status=timeout`.
   */
  timeout?: boolean;
  /**
   * Marks a provider credit/quota-exhaustion failure (e.g. HTTP 402). The review
   * could not run for reasons outside the MR's control, so the CLI treats it as
   * a non-fatal skip (warn, exit 0) rather than failing the pipeline.
   */
  quotaExceeded?: boolean;
}

export class GitlabReviewError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly timeout: boolean;
  readonly quotaExceeded: boolean;

  constructor(message: string, options: GitlabReviewErrorOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.hint = options.hint;
    this.timeout = options.timeout ?? false;
    this.quotaExceeded = options.quotaExceeded ?? false;
  }
}

/**
 * Patterns that identify a provider credit/quota-exhaustion error across
 * providers (Anthropic, OpenAI, Cloudflare AI Gateway, …). Matched against the
 * provider's error message. Deliberately excludes transient rate limits (429),
 * which are retryable rather than a billing dead-end.
 */
const QUOTA_EXCEEDED_PATTERNS: readonly RegExp[] = [
  /payment required/i,
  /insufficient[^.]*credit/i,
  /out of credit/i,
  /credit balance is too low/i,
  /insufficient_quota/i,
  /exceeded your current quota/i,
  /billing (?:hard )?limit/i,
];

/** True when `message` looks like a provider credit/quota-exhaustion error. */
export function isQuotaExceededMessage(message: string | undefined): boolean {
  if (!message) return false;
  return QUOTA_EXCEEDED_PATTERNS.some((pattern) => pattern.test(message));
}

/** True when `error` is (or reports) a provider credit/quota-exhaustion failure. */
export function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof GitlabReviewError && error.quotaExceeded) return true;
  if (error instanceof Error) return isQuotaExceededMessage(error.message);
  return false;
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

export class ParseError extends GitlabReviewError {
  constructor(message: string, options: Omit<GitlabReviewErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'PARSE_ERROR' });
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
