export interface GitLabClientOptions { gitlabUrl: string; token: string; fetchImpl?: typeof fetch }
export interface MergeRequest { source_branch: string; target_branch: string; source_project_id?: number; target_project_id?: number }
export interface Version { base_commit_sha: string; start_commit_sha: string; head_commit_sha: string }
export interface Discussion { notes: Array<{ body?: string }> }

export class GitLabClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitLabClientOptions) {
    this.base = options.gitlabUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  url(path: string, query: Record<string, string | number> = {}): string {
    const url = new URL(`${this.base}/api/v4${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url.toString();
  }

  async request<T>(path: string, init: RequestInit = {}, query: Record<string, string | number> = {}): Promise<T> {
    const response = await this.fetchImpl(this.url(path, query), {
      ...init,
      headers: { 'PRIVATE-TOKEN': this.token, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`GitLab API ${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  async paginate<T>(path: string, query: Record<string, string | number> = {}): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    while (true) {
      const response = await this.fetchImpl(this.url(path, { ...query, per_page: 100, page }), { headers: { 'PRIVATE-TOKEN': this.token } });
      if (!response.ok) throw new Error(`GitLab API GET ${path} failed: ${response.status} ${await response.text()}`);
      items.push(...await response.json() as T[]);
      const next = response.headers.get('x-next-page');
      if (!next) break;
      page = Number(next);
    }
    return items;
  }

  getMergeRequest(project: string, mr: string): Promise<MergeRequest> {
    return this.request(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}`);
  }

  async getLatestVersion(project: string, mr: string): Promise<Version> {
    const versions = await this.paginate<Version>(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/versions`);
    if (!versions[0]) throw new Error('No GitLab MR version found. Ensure the merge request has a diff version.');
    return versions[0];
  }

  getDiscussions(project: string, mr: string): Promise<Discussion[]> {
    return this.paginate(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/discussions`);
  }

  postDiscussion(project: string, mr: string, payload: unknown): Promise<unknown> {
    return this.request(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/discussions`, { method: 'POST', body: JSON.stringify(payload) });
  }
}
