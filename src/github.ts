import { GitHubApiError } from './errors.js';

/**
 * Metadata about a single completed HTTP request, reported to `onResponse`.
 * Deliberately telemetry-agnostic: the OTel bridge maps these onto HTTP
 * semantic-convention span attributes, but the client itself has no OTel
 * dependency. Carries no secrets — the token lives in a request header, not
 * the URL.
 */
export interface GitHubResponseInfo {
  method: string;
  path: string;
  url: string;
  status: number;
  /** Parsed Content-Length header in bytes, when the response provided one. */
  responseContentLength?: number;
}

export interface GitHubClientOptions {
  /**
   * REST API base, honoring `GITHUB_API_URL` (default `https://api.github.com`;
   * GitHub Enterprise sets it to e.g. `https://ghe.example.com/api/v3`). Paths
   * are appended directly, so the base must already include any `/api/v3` prefix.
   */
  apiUrl?: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeout?: number;
  /**
   * Optional instrumentation callback invoked once per completed HTTP response
   * (success or error status), before any error is thrown. Used to surface HTTP
   * metadata to diagnostics/OTel without coupling the client to those layers.
   */
  onResponse?: (info: GitHubResponseInfo) => void;
}

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const GITHUB_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Extract the `rel="next"` URL from a GitHub `Link` response header, or `null`
 * when there is no next page. GitHub paginates with absolute URLs in this header
 * rather than the page-number headers GitLab uses.
 */
export function parseNextLink(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export interface PullRequestRef {
  ref: string;
  sha: string;
}

export interface PullRequest {
  head: PullRequestRef;
  base: PullRequestRef;
  /** PR title — the one-line declared intent of the change. May be empty. */
  title?: string;
  /** PR body — the author's full reasoning / decision log. May be empty or null. */
  body?: string | null;
}

export interface GitHubUser {
  id: number;
  login: string;
}

/** An inline pull-request review comment (positioned against the diff). */
export interface PullRequestReviewComment {
  id: number;
  body?: string | null;
  path?: string;
  /** Line in the diff's new file, when the comment still anchors to it. */
  line?: number | null;
  original_line?: number | null;
  side?: string | null;
  in_reply_to_id?: number;
  user?: GitHubUser | null;
}

/** A non-positional issue/PR-level comment (the summary note lives here). */
export interface IssueComment {
  id: number;
  body?: string | null;
  user?: GitHubUser | null;
}

/** A single inline comment in a batched review payload. */
export interface ReviewCommentInput {
  path: string;
  body: string;
  line?: number;
  side?: string;
  start_line?: number;
  start_side?: string;
}

/**
 * Payload for a batched pull-request review. Posted as one atomic review
 * (`event: 'COMMENT'`) to avoid per-comment secondary rate limits.
 */
export interface CreateReviewInput {
  commit_id: string;
  event?: string;
  body?: string;
  comments?: ReviewCommentInput[];
}

export interface Review {
  id: number;
}

/** Minimal shape of the `reviewThreads` GraphQL query response we consume. */
interface ReviewThreadsResponse {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: {
          isResolved?: boolean;
          comments?: { nodes?: { databaseId?: number | null }[] };
        }[];
      };
    };
  } | null;
}

const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $pull: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pull) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            comments(first: 100) { nodes { databaseId } }
          }
        }
      }
    }
  }`;

export class GitHubClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeout: number;
  private readonly onResponse?: (info: GitHubResponseInfo) => void;

  constructor(options: GitHubClientOptions) {
    this.base = (options.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onResponse = options.onResponse;
  }

  private reportResponse(method: string, path: string, url: string, response: Response): void {
    if (!this.onResponse) return;
    const header = response.headers.get('content-length');
    // Treat a present-but-blank header as absent: Number('') / Number('  ') are 0
    // (finite), which would otherwise be reported as a real body size of 0.
    const length = header !== null && header.trim() !== '' ? Number(header) : NaN;
    this.onResponse({
      method,
      path,
      url,
      status: response.status,
      responseContentLength: Number.isFinite(length) ? length : undefined,
    });
  }

  url(path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private headers(headers?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: GITHUB_ACCEPT,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...headers,
    };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    method: string,
    path: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeout);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      this.reportResponse(method, path, url, response);
      return response;
    } catch (error) {
      if (isAbortError(error)) {
        throw new GitHubApiError(
          `GitHub API ${method} ${path} timed out after ${this.requestTimeout}ms`,
          {
            method,
            path,
            timeout: true,
            hint: 'Check GitHub API availability or increase requestTimeout.',
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private failure(method: string, path: string, response: Response, responseBody: string): never {
    throw new GitHubApiError(
      `GitHub API ${method} ${path} failed: ${response.status} ${response.statusText}`,
      {
        method,
        path,
        status: response.status,
        responseBody,
        hint: 'Check the GitHub API URL, token permissions, repository (owner/repo), and pull request number.',
      },
    );
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const response = await this.fetchWithTimeout(
      this.url(path, query),
      {
        ...init,
        headers: this.headers({
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers as Record<string, string> | undefined),
        }),
      },
      method,
      path,
    );

    if (!response.ok) {
      this.failure(method, path, response, await response.text());
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** Follow GitHub `Link` `rel="next"` headers, accumulating every page. */
  async paginate<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = this.url(path, { ...query, per_page: 100 });

    while (url) {
      const response = await this.fetchWithTimeout(url, { headers: this.headers() }, 'GET', path);

      if (!response.ok) {
        this.failure('GET', path, response, await response.text());
      }

      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) {
        throw new GitHubApiError(`GitHub API GET ${path} returned a non-array paginated response`, {
          method: 'GET',
          path,
          hint: 'The GitHub API response shape was unexpected.',
        });
      }
      items.push(...(body as T[]));

      url = parseNextLink(response.headers.get('link'));
    }

    return items;
  }

  getPullRequest(owner: string, repo: string, pull: number): Promise<PullRequest> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pull}`,
    );
  }

  listReviewComments(
    owner: string,
    repo: string,
    pull: number,
  ): Promise<PullRequestReviewComment[]> {
    return this.paginate(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pull}/comments`,
    );
  }

  listIssueComments(owner: string, repo: string, pull: number): Promise<IssueComment[]> {
    return this.paginate(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pull}/comments`,
    );
  }

  createReview(
    owner: string,
    repo: string,
    pull: number,
    payload: CreateReviewInput,
  ): Promise<Review> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pull}/reviews`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
  }

  createIssueComment(
    owner: string,
    repo: string,
    pull: number,
    body: string,
  ): Promise<IssueComment> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pull}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
  }

  updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<IssueComment> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
      { method: 'PATCH', body: JSON.stringify({ body }) },
    );
  }

  getCurrentUser(): Promise<GitHubUser> {
    return this.request('/user');
  }

  /**
   * Derive the GraphQL endpoint from the REST base. github.com exposes GraphQL
   * at `<origin>/graphql`, while GitHub Enterprise Server exposes it at
   * `<origin>/api/graphql` (its REST base is `<origin>/api/v3`).
   */
  private graphqlEndpoint(): string {
    const suffix = '/api/v3';
    if (this.base.endsWith(suffix)) return `${this.base.slice(0, -suffix.length)}/api/graphql`;
    return `${this.base}/graphql`;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const url = this.graphqlEndpoint();
    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query, variables }),
      },
      'POST',
      '/graphql',
    );
    if (!response.ok) this.failure('POST', '/graphql', response, await response.text());
    const text = await response.text();
    const parsed = JSON.parse(text) as { data?: T; errors?: { message?: string }[] };
    if (parsed.errors && parsed.errors.length > 0) {
      throw new GitHubApiError(
        `GitHub API POST /graphql failed: ${parsed.errors.map((e) => e.message ?? '').join('; ')}`,
        {
          method: 'POST',
          path: '/graphql',
          responseBody: text,
          hint: 'Ensure the token can read pull-request review threads (pull-requests: read / repo scope).',
        },
      );
    }
    return parsed.data as T;
  }

  /**
   * Return the database IDs of review comments that belong to a **resolved**
   * review thread. GitHub's REST comment endpoints omit thread-resolution state;
   * it is only exposed via GraphQL `reviewThreads.isResolved`. Callers use this
   * set to mark normalized notes resolved so resolved threads are excluded from
   * summary carry-over and prior-thread context. Paginates over threads.
   */
  async listResolvedReviewCommentIds(
    owner: string,
    repo: string,
    pull: number,
  ): Promise<Set<number>> {
    const resolved = new Set<number>();
    let cursor: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const data: ReviewThreadsResponse = await this.graphql(REVIEW_THREADS_QUERY, {
        owner,
        repo,
        pull,
        cursor,
      });
      const threads = data.repository?.pullRequest?.reviewThreads;
      if (!threads) break;
      for (const thread of threads.nodes ?? []) {
        if (!thread.isResolved) continue;
        for (const comment of thread.comments?.nodes ?? []) {
          if (typeof comment.databaseId === 'number') resolved.add(comment.databaseId);
        }
      }
      hasNext = threads.pageInfo?.hasNextPage ?? false;
      cursor = threads.pageInfo?.endCursor ?? null;
      if (!cursor) hasNext = false;
    }
    return resolved;
  }
}
