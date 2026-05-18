export class GitLabClient {
    base;
    token;
    fetchImpl;
    constructor(options) {
        this.base = options.gitlabUrl.replace(/\/$/, '');
        this.token = options.token;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    url(path, query = {}) {
        const url = new URL(`${this.base}/api/v4${path}`);
        for (const [key, value] of Object.entries(query))
            url.searchParams.set(key, String(value));
        return url.toString();
    }
    async request(path, init = {}, query = {}) {
        const response = await this.fetchImpl(this.url(path, query), {
            ...init,
            headers: { 'PRIVATE-TOKEN': this.token, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        });
        if (!response.ok)
            throw new Error(`GitLab API ${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
        return response.json();
    }
    async paginate(path, query = {}) {
        const items = [];
        let page = 1;
        while (true) {
            const response = await this.fetchImpl(this.url(path, { ...query, per_page: 100, page }), { headers: { 'PRIVATE-TOKEN': this.token } });
            if (!response.ok)
                throw new Error(`GitLab API GET ${path} failed: ${response.status} ${await response.text()}`);
            items.push(...await response.json());
            const next = response.headers.get('x-next-page');
            if (!next)
                break;
            page = Number(next);
        }
        return items;
    }
    getMergeRequest(project, mr) {
        return this.request(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}`);
    }
    async getLatestVersion(project, mr) {
        const versions = await this.paginate(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/versions`);
        if (!versions[0])
            throw new Error('No GitLab MR version found. Ensure the merge request has a diff version.');
        return versions[0];
    }
    getDiscussions(project, mr) {
        return this.paginate(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/discussions`);
    }
    postDiscussion(project, mr, payload) {
        return this.request(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/discussions`, { method: 'POST', body: JSON.stringify(payload) });
    }
}
//# sourceMappingURL=gitlab.js.map