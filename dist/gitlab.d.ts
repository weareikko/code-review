export interface GitLabClientOptions {
    gitlabUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
}
export interface MergeRequest {
    source_branch: string;
    target_branch: string;
    source_project_id?: number;
    target_project_id?: number;
}
export interface Version {
    base_commit_sha: string;
    start_commit_sha: string;
    head_commit_sha: string;
}
export interface Discussion {
    notes: Array<{
        body?: string;
    }>;
}
export declare class GitLabClient {
    private readonly base;
    private readonly token;
    private readonly fetchImpl;
    constructor(options: GitLabClientOptions);
    url(path: string, query?: Record<string, string | number>): string;
    request<T>(path: string, init?: RequestInit, query?: Record<string, string | number>): Promise<T>;
    paginate<T>(path: string, query?: Record<string, string | number>): Promise<T[]>;
    getMergeRequest(project: string, mr: string): Promise<MergeRequest>;
    getLatestVersion(project: string, mr: string): Promise<Version>;
    getDiscussions(project: string, mr: string): Promise<Discussion[]>;
    postDiscussion(project: string, mr: string, payload: unknown): Promise<unknown>;
}
