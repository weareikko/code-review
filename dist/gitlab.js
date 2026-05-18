export class GitLabClient {
    base;
    token;
    authHeader;
    fetchImpl;
    constructor(options) {
        this.base = options.gitlabUrl.replace(/\/$/, '');
        this.token = options.token;
        this.authHeader = options.authHeader ?? 'PRIVATE-TOKEN';
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    url(path, query = {}) {
        const url = new URL(`${this.base}/api/v4${path}`);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined)
                url.searchParams.set(key, String(value));
        }
        return url.toString();
    }
    headers(headers) {
        return {
            [this.authHeader]: this.token,
            Accept: 'application/json',
            ...(headers ?? {}),
        };
    }
    async request(path, init = {}, query = {}) {
        const response = await this.fetchImpl(this.url(path, query), {
            ...init,
            headers: this.headers({ 'Content-Type': 'application/json', ...(init.headers ?? {}) }),
        });
        if (!response.ok) {
            throw new Error(`GitLab API ${init.method ?? 'GET'} ${path} failed: ${response.status} ${response.statusText}\n${await response.text()}`);
        }
        if (response.status === 204)
            return undefined;
        const text = await response.text();
        if (!text)
            return undefined;
        return JSON.parse(text);
    }
    async paginate(path, query = {}) {
        const items = [];
        let page = 1;
        while (true) {
            const response = await this.fetchImpl(this.url(path, { ...query, per_page: 100, page }), {
                headers: this.headers(),
            });
            if (!response.ok) {
                throw new Error(`GitLab API GET ${path} failed: ${response.status} ${response.statusText}\n${await response.text()}`);
            }
            const body = (await response.json());
            if (!Array.isArray(body)) {
                throw new Error(`GitLab API GET ${path} returned a non-array paginated response`);
            }
            items.push(...body);
            const next = response.headers.get('x-next-page')?.trim();
            if (!next)
                break;
            const nextPage = Number(next);
            if (!Number.isInteger(nextPage) || nextPage <= page) {
                throw new Error(`GitLab API GET ${path} returned invalid x-next-page header: ${next}`);
            }
            page = nextPage;
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