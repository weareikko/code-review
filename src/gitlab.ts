import type { GitLabAuthHeader } from './config.js';
import { GitLabApiError } from './errors.js';

export interface GitLabClientOptions {
  gitlabUrl: string;
  token: string;
  authHeader?: GitLabAuthHeader;
  fetchImpl?: typeof fetch;
  requestTimeout?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export interface MergeRequest {
  source_branch: string;
  target_branch: string;
  source_project_id?: number;
  target_project_id?: number;
}

export interface Version {
  id?: number;
  base_commit_sha: string;
  start_commit_sha: string;
  head_commit_sha: string;
}

export interface DiscussionNote {
  id?: number;
  body?: string | null;
}

export interface Discussion {
  notes: DiscussionNote[];
}

export interface MergeRequestNote {
  id: number;
  body: string;
}

export interface DraftNote {
  id: number;
  author_id: number;
  note: string;
}

export interface CurrentUser {
  id: number;
}

export class GitLabClient {
  private readonly base: string;
  private readonly token: string;
  private readonly authHeader: GitLabAuthHeader;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeout: number;

  constructor(options: GitLabClientOptions) {
    this.base = options.gitlabUrl.replace(/\/$/, '');
    this.token = options.token;
    this.authHeader = options.authHeader ?? 'PRIVATE-TOKEN';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  url(path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
    const url = new URL(`${this.base}/api/v4${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private headers(headers?: Record<string, string>): Record<string, string> {
    return {
      [this.authHeader]: this.token,
      Accept: 'application/json',
      ...headers,
    };
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeout);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, query), {
        ...init,
        signal: controller.signal,
        headers: this.headers({
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers as Record<string, string> | undefined),
        }),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new GitLabApiError(
          `GitLab API ${init.method ?? 'GET'} ${path} timed out after ${this.requestTimeout}ms`,
          {
            method: init.method ?? 'GET',
            path,
            hint: 'Check GitLab API availability or increase requestTimeout.',
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const responseBody = await response.text();
      throw new GitLabApiError(
        `GitLab API ${init.method ?? 'GET'} ${path} failed: ${response.status} ${response.statusText}`,
        {
          method: init.method ?? 'GET',
          path,
          status: response.status,
          responseBody,
          hint: 'Check the GitLab URL, token permissions, project ID/path, and merge request IID.',
        },
      );
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async paginate<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;

    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeout);
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(path, { ...query, per_page: 100, page }), {
          headers: this.headers(),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw new GitLabApiError(
            `GitLab API GET ${path} timed out after ${this.requestTimeout}ms`,
            {
              method: 'GET',
              path,
              hint: 'Check GitLab API availability or increase requestTimeout.',
            },
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const responseBody = await response.text();
        throw new GitLabApiError(
          `GitLab API GET ${path} failed: ${response.status} ${response.statusText}`,
          {
            method: 'GET',
            path,
            status: response.status,
            responseBody,
            hint: 'Check the GitLab URL, token permissions, project ID/path, and merge request IID.',
          },
        );
      }

      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) {
        throw new GitLabApiError(`GitLab API GET ${path} returned a non-array paginated response`, {
          method: 'GET',
          path,
          hint: 'The GitLab API response shape was unexpected.',
        });
      }
      items.push(...(body as T[]));

      const next = response.headers.get('x-next-page')?.trim();
      if (!next) break;
      const nextPage = Number(next);
      if (!Number.isInteger(nextPage) || nextPage <= page) {
        throw new GitLabApiError(
          `GitLab API GET ${path} returned invalid x-next-page header: ${next}`,
          {
            method: 'GET',
            path,
            hint: 'The GitLab API pagination headers were unexpected.',
          },
        );
      }
      page = nextPage;
    }

    return items;
  }

  getMergeRequest(project: string, mr: string): Promise<MergeRequest> {
    return this.request(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}`,
    );
  }

  async getLatestVersion(project: string, mr: string): Promise<Version> {
    const versions = await this.paginate<Version>(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/versions`,
    );
    if (!versions[0])
      throw new GitLabApiError('No GitLab MR version found.', {
        method: 'GET',
        path: `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/versions`,
        hint: 'Ensure the merge request has a diff version.',
      });
    return versions[0];
  }

  getDiscussions(project: string, mr: string): Promise<Discussion[]> {
    return this.paginate(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/discussions`,
    );
  }

  postDiscussion(project: string, mr: string, payload: unknown): Promise<unknown> {
    return this.request(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/discussions`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
  }

  createMergeRequestNote(project: string, mr: string, body: string): Promise<MergeRequestNote> {
    return this.request(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/notes`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
  }

  updateMergeRequestNote(
    project: string,
    mr: string,
    noteId: number,
    body: string,
  ): Promise<MergeRequestNote> {
    return this.request(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/notes/${noteId}`,
      { method: 'PUT', body: JSON.stringify({ body }) },
    );
  }

  getCurrentUser(): Promise<CurrentUser> {
    return this.request('/user');
  }

  listDraftNotes(project: string, mr: string): Promise<DraftNote[]> {
    return this.paginate(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/draft_notes`,
    );
  }

  createDraftNote(project: string, mr: string, payload: unknown): Promise<DraftNote> {
    // The draft notes API uses `note` instead of `body` for the comment text.
    const { body, ...rest } = payload as Record<string, unknown>;
    const draftPayload = body !== undefined ? { note: body, ...rest } : payload;
    return this.request(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/draft_notes`,
      { method: 'POST', body: JSON.stringify(draftPayload) },
    );
  }

  async deleteDraftNote(project: string, mr: string, id: number): Promise<void> {
    await this.request(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/draft_notes/${id}`,
      { method: 'DELETE' },
    );
  }

  async bulkPublishDraftNotes(project: string, mr: string): Promise<void> {
    await this.request(
      `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/draft_notes/bulk_publish`,
      { method: 'POST' },
    );
  }
}
