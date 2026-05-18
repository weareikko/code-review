import { readFileSync } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
//#region src/config.ts
var BOOLEAN_FLAGS = new Set([
	"dry-run",
	"no-post",
	"help",
	"version"
]);
function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "-h") {
			args.help = true;
			continue;
		}
		if (arg === "-v") {
			args.version = true;
			continue;
		}
		if (!arg.startsWith("--")) continue;
		const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
		if (!rawKey) continue;
		const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if (inlineValue !== void 0) args[key] = inlineValue;
		else if (BOOLEAN_FLAGS.has(rawKey)) args[key] = true;
		else {
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
			args[key] = next;
			i += 1;
		}
	}
	return args;
}
function first(...values) {
	return values.find((value) => typeof value === "string" && value.length > 0);
}
function toBoolean(value) {
	return value === true || value === "true" || value === "1";
}
function resolveMinSeverity(value) {
	return String(value ?? "").trim().toLowerCase();
}
function resolveGitLabToken(args, env) {
	if (typeof args.gitlabToken === "string" && args.gitlabToken.length > 0) return {
		token: args.gitlabToken,
		header: "PRIVATE-TOKEN"
	};
	if (env.GITLAB_TOKEN) return {
		token: env.GITLAB_TOKEN,
		header: "PRIVATE-TOKEN"
	};
	if (env.GLAB_CLI_TOKEN) return {
		token: env.GLAB_CLI_TOKEN,
		header: "PRIVATE-TOKEN"
	};
	if (env.CI_JOB_TOKEN) return {
		token: env.CI_JOB_TOKEN,
		header: "JOB-TOKEN"
	};
	if (env.GITLAB_PRIVATE_TOKEN) return {
		token: env.GITLAB_PRIVATE_TOKEN,
		header: "PRIVATE-TOKEN"
	};
	return {
		token: "",
		header: "PRIVATE-TOKEN"
	};
}
function resolveConfig(argv = process.argv.slice(2), env = process.env) {
	const args = parseArgs(argv);
	const gitlabUrl = String(args.gitlabUrl ?? first(env.CI_SERVER_URL, env.CI_SERVER_HOST ? `https://${env.CI_SERVER_HOST}` : void 0) ?? "").replace(/\/$/, "");
	const token = resolveGitLabToken(args, env);
	return {
		project: String(args.project ?? env.CI_PROJECT_ID ?? ""),
		mr: String(args.mr ?? env.CI_MERGE_REQUEST_IID ?? ""),
		gitlabUrl,
		gitlabToken: token.token,
		gitlabAuthHeader: token.header,
		model: String(args.model ?? env.PI_REVIEWER_MODEL ?? "anthropic/claude-sonnet-4-5"),
		minSeverity: resolveMinSeverity(args.minSeverity ?? env.PI_REVIEWER_MIN_SEVERITY ?? "info"),
		apiKey: String(args.apiKey ?? first(env.PI_API_KEY, env.ANTHROPIC_API_KEY, env.CLAUDE_API_KEY) ?? ""),
		reviewFile: String(args.reviewFile ?? "pi-review.md"),
		output: String(args.output ?? "review-comments.json"),
		dryRun: toBoolean(args.dryRun),
		noPost: toBoolean(args.noPost),
		cwd: String(args.cwd ?? process.cwd())
	};
}
function validateConfig(config) {
	const missing = [
		["project", config.project],
		["mr", config.mr],
		["gitlab-url", config.gitlabUrl],
		["gitlab-token", config.gitlabToken],
		["api-key", config.apiKey]
	].filter(([, value]) => !value).map(([name]) => `--${name}`);
	if (missing.length > 0) throw new Error(`Missing required configuration: ${missing.join(", ")}. Provide CLI flags or GitLab CI environment variables.`);
	if (![
		"info",
		"warn",
		"critical"
	].includes(config.minSeverity)) throw new Error("--min-severity must be one of: info, warn, critical");
}
//#endregion
//#region src/fingerprints.ts
var FINGERPRINT_MARKER_RE$1 = /<!--\s*pi-reviewer:fingerprint-(?:primary|secondary):([a-f0-9]+)\s*-->/gi;
var STRIP_FINGERPRINT_MARKER_RE = /<!--\s*pi-reviewer:fingerprint-(?:primary|secondary):[a-f0-9]+\s*-->/gi;
function sha256(input) {
	return createHash("sha256").update(input).digest("hex");
}
function normalizeBody(body) {
	return body.replace(STRIP_FINGERPRINT_MARKER_RE, "").replace(/^(?:🔴|🟡|🔵)\s*/gmu, "").replace(/\s+/g, " ").trim();
}
function matchesFile(state, file) {
	return state.oldPath === file || state.newPath === file;
}
function parseHunkHeader(line) {
	const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	if (!match) return null;
	return {
		oldLine: Number(match[1]),
		newLine: Number(match[2])
	};
}
function hunkContainsLine(hunkLines, targetLine, side, startOld, startNew) {
	let oldLine = startOld;
	let newLine = startNew;
	for (const text of hunkLines.slice(1)) {
		const prefix = text[0] ?? " ";
		if (side === "RIGHT" && prefix !== "-" && newLine === targetLine) return true;
		if (side === "LEFT" && prefix !== "+" && oldLine === targetLine) return true;
		if (prefix !== "+") oldLine += 1;
		if (prefix !== "-") newLine += 1;
	}
	return false;
}
function extractDiffHunkContext(diff, file, line, side) {
	const lines = diff.split("\n");
	const state = {
		oldPath: "",
		newPath: ""
	};
	for (let i = 0; i < lines.length; i += 1) {
		const text = lines[i];
		if (text.startsWith("diff --git ")) {
			state.oldPath = "";
			state.newPath = "";
			continue;
		}
		const oldMatch = text.match(/^--- (?:a\/(.*)|\/dev\/null)$/);
		if (oldMatch) state.oldPath = oldMatch[1] ?? "/dev/null";
		const newMatch = text.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/);
		if (newMatch) state.newPath = newMatch[1] ?? "/dev/null";
		if (!text.startsWith("@@") || !matchesFile(state, file)) continue;
		const header = parseHunkHeader(text);
		if (!header) continue;
		let end = i + 1;
		while (end < lines.length && !lines[end].startsWith("@@") && !lines[end].startsWith("diff --git ")) end += 1;
		const hunkLines = lines.slice(i, end);
		if (hunkContainsLine(hunkLines, line, side, header.oldLine, header.newLine)) return hunkLines.join("\n");
	}
	return `${file}:${side}:${line}`;
}
function fingerprints(comment, hunkContext) {
	const bodyHash = sha256(normalizeBody(comment.body));
	const hunkHash = sha256(hunkContext);
	return {
		primary: sha256([
			comment.file,
			comment.side,
			comment.line,
			bodyHash,
			hunkHash
		].join("|")),
		secondary: sha256([
			comment.file,
			comment.side,
			bodyHash,
			hunkHash
		].join("|"))
	};
}
function appendFingerprintMarkers(body, fp) {
	return `${body.trim()}\n\n<!-- pi-reviewer:fingerprint-primary:${fp.primary} -->\n<!-- pi-reviewer:fingerprint-secondary:${fp.secondary} -->`;
}
function extractExistingFingerprints(discussions) {
	const set = /* @__PURE__ */ new Set();
	for (const discussion of discussions) for (const note of discussion.notes ?? []) for (const match of String(note.body ?? "").matchAll(FINGERPRINT_MARKER_RE$1)) set.add(match[1]);
	return set;
}
//#endregion
//#region src/git.ts
var exec = promisify(execFile);
var DEFAULT_CODEQUALITY_ARTIFACTS = [
	"gl-code-quality-report.json",
	"codequality.json",
	"codeclimate.json",
	"code-quality-report.json"
];
function gitErrorMessage(error) {
	const err = error;
	return [
		err.message,
		err.stderr,
		err.stdout
	].filter(Boolean).join("\n").trim();
}
async function git(args, options = {}) {
	const { stdout } = await exec("git", args, {
		cwd: options.cwd,
		maxBuffer: 50 * 1024 * 1024
	});
	return stdout;
}
function remoteRef(remote, branch) {
	return `refs/remotes/${remote}/${branch}`;
}
async function fetchBranch(remote, branch, options) {
	await git([
		"fetch",
		"--no-tags",
		remote,
		`+refs/heads/${branch}:${remoteRef(remote, branch)}`
	], options);
}
async function isTracked(path, options) {
	try {
		await git([
			"ls-files",
			"--error-unmatch",
			"--",
			path
		], options);
		return true;
	} catch {
		return false;
	}
}
async function removeGeneratedCodeQualityArtifacts(paths = DEFAULT_CODEQUALITY_ARTIFACTS, options = {}) {
	const removed = [];
	for (const path of paths) {
		if (await isTracked(path, options)) continue;
		try {
			await unlink(options.cwd ? join(options.cwd, path) : path);
			removed.push(path);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	return removed;
}
async function prepareGitHistory(sourceBranch, targetBranch, options = {}) {
	const remote = options.remote ?? "origin";
	await removeGeneratedCodeQualityArtifacts(options.codeQualityArtifacts, options);
	await git([
		"fetch",
		"--unshallow",
		"--no-tags",
		remote
	], options).catch(() => void 0);
	const fetchErrors = [];
	for (const branch of [targetBranch, sourceBranch]) try {
		await fetchBranch(remote, branch, options);
	} catch (error) {
		fetchErrors.push(`${branch}: ${gitErrorMessage(error)}`);
	}
	if (fetchErrors.length === 2) throw new Error(`Unable to fetch MR source/target branches from ${remote}.\n${fetchErrors.join("\n")}`);
	try {
		await git([
			"merge-base",
			remoteRef(remote, targetBranch),
			"HEAD"
		], options);
	} catch (error) {
		const fetchDetail = fetchErrors.length > 0 ? `\nFetch warnings:\n${fetchErrors.join("\n")}` : "";
		throw new Error(`Unable to prepare Git history for MR review: merge-base ${remoteRef(remote, targetBranch)} HEAD failed. Set GIT_DEPTH: 0 or ensure ${remote}/${targetBranch} is fetchable.${fetchDetail}\n${gitErrorMessage(error)}`, { cause: error });
	}
}
async function getMergeDiff(targetBranch, options = {}) {
	const remote = options.remote ?? "origin";
	const context = options.context ?? 20;
	return git([
		"diff",
		`${remoteRef(remote, targetBranch)}...HEAD`,
		`--unified=${context}`,
		"--"
	], options);
}
//#endregion
//#region src/gitlab.ts
var GitLabClient = class {
	base;
	token;
	authHeader;
	fetchImpl;
	constructor(options) {
		this.base = options.gitlabUrl.replace(/\/$/, "");
		this.token = options.token;
		this.authHeader = options.authHeader ?? "PRIVATE-TOKEN";
		this.fetchImpl = options.fetchImpl ?? fetch;
	}
	url(path, query = {}) {
		const url = new URL(`${this.base}/api/v4${path}`);
		for (const [key, value] of Object.entries(query)) if (value !== void 0) url.searchParams.set(key, String(value));
		return url.toString();
	}
	headers(headers) {
		return {
			[this.authHeader]: this.token,
			Accept: "application/json",
			...headers
		};
	}
	async request(path, init = {}, query = {}) {
		const response = await this.fetchImpl(this.url(path, query), {
			...init,
			headers: this.headers({
				"Content-Type": "application/json",
				...init.headers
			})
		});
		if (!response.ok) throw new Error(`GitLab API ${init.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}\n${await response.text()}`);
		if (response.status === 204) return void 0;
		const text = await response.text();
		if (!text) return void 0;
		return JSON.parse(text);
	}
	async paginate(path, query = {}) {
		const items = [];
		let page = 1;
		while (true) {
			const response = await this.fetchImpl(this.url(path, {
				...query,
				per_page: 100,
				page
			}), { headers: this.headers() });
			if (!response.ok) throw new Error(`GitLab API GET ${path} failed: ${response.status} ${response.statusText}\n${await response.text()}`);
			const body = await response.json();
			if (!Array.isArray(body)) throw new Error(`GitLab API GET ${path} returned a non-array paginated response`);
			items.push(...body);
			const next = response.headers.get("x-next-page")?.trim();
			if (!next) break;
			const nextPage = Number(next);
			if (!Number.isInteger(nextPage) || nextPage <= page) throw new Error(`GitLab API GET ${path} returned invalid x-next-page header: ${next}`);
			page = nextPage;
		}
		return items;
	}
	getMergeRequest(project, mr) {
		return this.request(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}`);
	}
	async getLatestVersion(project, mr) {
		const versions = await this.paginate(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/versions`);
		if (!versions[0]) throw new Error("No GitLab MR version found. Ensure the merge request has a diff version.");
		return versions[0];
	}
	getDiscussions(project, mr) {
		return this.paginate(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/discussions`);
	}
	postDiscussion(project, mr, payload) {
		return this.request(`/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(mr)}/discussions`, {
			method: "POST",
			body: JSON.stringify(payload)
		});
	}
};
//#endregion
//#region src/types.ts
function toPiReviewerSeverity(severity) {
	return severity === "critical" ? "CRITICAL" : severity === "warn" ? "WARN" : "INFO";
}
function normalizeSeverity(value) {
	const normalized = String(value ?? "").trim().toLowerCase();
	if (normalized === "critical" || normalized === "error" || normalized === "🔴") return "critical";
	if (normalized === "warn" || normalized === "warning" || normalized === "🟡") return "warn";
	return "info";
}
//#endregion
//#region src/parser.ts
var HEADER_RE = /^\s*(?<emoji>[🔴🟡🔵])?\s*(?<file>.+):(\d+)\s+\((?<side>LEFT|RIGHT)\)\s*$/u;
var GITHUB_STYLE_HEADER_RE = /^\s*(?<emoji>[🔴🟡🔵])?\s*(?:\*\*)?`?(?<file>.+):(\d+)`?(?:\*\*)?\s*(?:[·-]|\()\s*(?<side>LEFT|RIGHT)\)?\s*$/u;
var FINGERPRINT_MARKER_RE = /<!--\s*pi-reviewer:fingerprint-(?:primary|secondary):[a-f0-9]+\s*-->/gi;
function severityFromEmoji(emoji) {
	if (emoji === "🔴") return "critical";
	if (emoji === "🟡") return "warn";
	return "info";
}
function inferSeverity(body, fallback) {
	const first = body.trimStart()[0];
	if (first === "🔴" || first === "🟡" || first === "🔵") return normalizeSeverity(first);
	return fallback;
}
function normalizeSide(value) {
	return String(value ?? "").toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
}
function addJsonComment(out, item) {
	if (!item || typeof item !== "object") return;
	const value = item;
	const file = value.file ?? value.path ?? value.new_path ?? value.old_path;
	const rawLine = value.line ?? value.new_line ?? value.old_line;
	const line = Number(rawLine);
	const body = String(value.body ?? value.comment ?? value.message ?? "").replace(FINGERPRINT_MARKER_RE, "").trim();
	const side = normalizeSide(value.side ?? (value.old_line ? "LEFT" : "RIGHT"));
	if (typeof file === "string" && file.length > 0 && Number.isInteger(line) && line > 0 && body.length > 0) out.push({
		file,
		line,
		side,
		severity: normalizeSeverity(value.severity),
		body
	});
}
function parseJsonComments(markdown, out) {
	for (const match of markdown.matchAll(/```json\s*([\s\S]*?)```/gi)) try {
		const parsed = JSON.parse(match[1] ?? "");
		const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.comments) ? parsed.comments : [];
		for (const item of list) addJsonComment(out, item);
	} catch {}
	for (const match of markdown.matchAll(/<!--\s*pi-reviewer-comment\s*([\s\S]*?)-->/gi)) try {
		addJsonComment(out, JSON.parse(match[1] ?? ""));
	} catch {}
}
function matchHeader(line) {
	const match = line.match(HEADER_RE) ?? line.match(GITHUB_STYLE_HEADER_RE);
	if (!match?.groups) return null;
	const rawLine = match[3];
	const number = Number(rawLine);
	if (!Number.isInteger(number) || number <= 0) return null;
	return {
		file: match.groups.file.trim().replace(/^`|`$/g, ""),
		line: number,
		side: match.groups.side,
		severity: severityFromEmoji(match.groups.emoji)
	};
}
function parseInlineSection(markdown, out, warnings) {
	const marker = markdown.search(/^==\s*Inline Comments\s*==\s*$/im);
	if (marker === -1) return;
	const section = markdown.slice(marker).split(/\r?\n/).slice(1);
	let current = null;
	let sawBodyBeforeHeader = false;
	const flush = () => {
		if (!current) return;
		const body = current.body.join("\n").replace(FINGERPRINT_MARKER_RE, "").trim();
		if (body.length > 0) out.push({
			file: current.file,
			line: current.line,
			side: current.side,
			severity: inferSeverity(body, current.severity),
			body
		});
		current = null;
	};
	for (const rawLine of section) {
		if (/^==\s*[^=].*==\s*$/.test(rawLine)) break;
		const header = matchHeader(rawLine);
		if (header) {
			flush();
			current = {
				...header,
				body: []
			};
			continue;
		}
		if (current) current.body.push(rawLine);
		else if (rawLine.trim().length > 0) sawBodyBeforeHeader = true;
	}
	flush();
	if (sawBodyBeforeHeader) warnings.push("Ignored text in the inline comments section before the first parseable comment header.");
}
function parseReviewMarkdownWithWarnings(markdown) {
	const comments = [];
	const warnings = [];
	parseJsonComments(markdown, comments);
	parseInlineSection(markdown, comments, warnings);
	return {
		comments,
		warnings
	};
}
//#endregion
//#region src/payloads.ts
function buildPayload(comment, body, refs) {
	return {
		body,
		position: {
			position_type: "text",
			base_sha: refs.base_sha,
			start_sha: refs.start_sha,
			head_sha: refs.head_sha,
			old_path: comment.file,
			new_path: comment.file,
			...comment.side === "LEFT" ? { old_line: comment.line } : { new_line: comment.line }
		}
	};
}
function buildGeneratedComments(comments, diff, refs, existingFingerprints) {
	const seen = new Set(existingFingerprints);
	return comments.map((comment) => {
		const fp = fingerprints(comment, extractDiffHunkContext(diff, comment.file, comment.line, comment.side));
		const duplicate = seen.has(fp.primary) || seen.has(fp.secondary);
		seen.add(fp.primary);
		seen.add(fp.secondary);
		return {
			comment,
			fingerprints: fp,
			duplicate,
			payload: buildPayload(comment, appendFingerprintMarkers(comment.body, fp), refs)
		};
	});
}
//#endregion
//#region src/pi-reviewer.ts
async function resolvePiReviewer() {
	const imported = await import(pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("pi-reviewer/package.json")), "dist/src/ci/review.js")).href);
	if (typeof imported.review !== "function") throw new Error("Unable to load pi-reviewer review() from pinned dependency.");
	return imported.review;
}
async function ensureReadableFile(path) {
	try {
		await access(path);
	} catch {
		throw new Error(`pi-reviewer did not generate ${path}`);
	}
	if ((await readFile(path, "utf8")).trim().length === 0) throw new Error(`pi-reviewer generated an empty review file at ${path}`);
}
async function runPiReviewer(config, options = {}) {
	const cwd = options.cwd ?? config.cwd;
	const review = options.review ?? await resolvePiReviewer();
	const generatedPath = resolve(cwd, "pi-review.md");
	const targetPath = resolve(cwd, config.reviewFile);
	await review({
		cwd,
		diff: options.diff,
		output: "file",
		model: config.model,
		minSeverity: toPiReviewerSeverity(config.minSeverity),
		piApiKey: config.apiKey
	});
	await ensureReadableFile(generatedPath);
	if (generatedPath !== targetPath) {
		await mkdir(dirname(targetPath), { recursive: true });
		try {
			await rename(generatedPath, targetPath);
		} catch {
			await writeFile(targetPath, await readFile(generatedPath, "utf8"), "utf8");
		}
	}
	await ensureReadableFile(targetPath);
}
//#endregion
//#region src/posting.ts
async function postGeneratedComments(gitlab, project, mr, generated) {
	let posted = 0;
	for (const item of generated) {
		if (item.duplicate) continue;
		await gitlab.postDiscussion(project, mr, item.payload);
		posted += 1;
	}
	return posted;
}
//#endregion
//#region src/cli.ts
var HELP = `Usage: gitlab-review [options]

Run pi-reviewer in GitLab CI and post deduplicated merge request discussions.

Options:
  --project <id>          GitLab project ID/path (default: CI_PROJECT_ID)
  --mr <iid>              Merge request IID (default: CI_MERGE_REQUEST_IID)
  --gitlab-url <url>      GitLab URL (default: CI_SERVER_URL or CI_SERVER_HOST)
  --gitlab-token <token>  GitLab token (default: GITLAB_TOKEN, GLAB_CLI_TOKEN, CI_JOB_TOKEN, GITLAB_PRIVATE_TOKEN)
  --api-key <key>         pi/AI API key (default: PI_API_KEY, ANTHROPIC_API_KEY, CLAUDE_API_KEY)
  --model <provider/id>   pi-reviewer model (default: anthropic/claude-sonnet-4-5)
  --min-severity <level>  info, warn, or critical (default: info)
  --review-file <path>    Raw pi-reviewer output file (default: pi-review.md)
  --output <path>         Generated payload artifact (default: review-comments.json)
  --dry-run               Generate artifacts and skip posting
  --no-post               Generate artifacts and skip posting
  --help, -h              Show help
  --version, -v           Show version
`;
function readVersion() {
	try {
		return JSON.parse(readFileSync(new URL("data:application/json;base64,ewogICJuYW1lIjogIkBzdHVkaW9tZXRhL2dpdGxhYi1yZXZpZXciLAogICJ2ZXJzaW9uIjogIjAuMS4wIiwKICAiZGVzY3JpcHRpb24iOiAiUnVuIHBpLXJldmlld2VyIGluIEdpdExhYiBDSSBhbmQgcG9zdCBkZWR1cGxpY2F0ZWQgTVIgZGlzY3Vzc2lvbnMuIiwKICAia2V5d29yZHMiOiBbCiAgICAiY2kiLAogICAgImNvZGUtcmV2aWV3IiwKICAgICJnaXRsYWIiLAogICAgIm1lcmdlLXJlcXVlc3QiLAogICAgInBpLXJldmlld2VyIgogIF0sCiAgImhvbWVwYWdlIjogImh0dHBzOi8vZ2l0aHViLmNvbS9pa2tvLWRldi9naXRsYWItcmV2aWV3I3JlYWRtZSIsCiAgImJ1Z3MiOiB7CiAgICAidXJsIjogImh0dHBzOi8vZ2l0aHViLmNvbS9pa2tvLWRldi9naXRsYWItcmV2aWV3L2lzc3VlcyIKICB9LAogICJyZXBvc2l0b3J5IjogewogICAgInR5cGUiOiAiZ2l0IiwKICAgICJ1cmwiOiAiZ2l0K3NzaDovL2dpdEBnaXRodWIuY29tL2lra28tZGV2L2dpdGxhYi1yZXZpZXcuZ2l0IgogIH0sCiAgImJpbiI6IHsKICAgICJnaXRsYWItcmV2aWV3IjogIi4vYmluL2dpdGxhYi1yZXZpZXcuanMiCiAgfSwKICAiZmlsZXMiOiBbCiAgICAiYmluLyIsCiAgICAiZGlzdC8iLAogICAgIlJFQURNRS5tZCIKICBdLAogICJ0eXBlIjogIm1vZHVsZSIsCiAgInB1Ymxpc2hDb25maWciOiB7CiAgICAiYWNjZXNzIjogInB1YmxpYyIKICB9LAogICJzY3JpcHRzIjogewogICAgImJ1aWxkIjogInZpdGUgYnVpbGQgJiYgdHNnbyAtLWVtaXREZWNsYXJhdGlvbk9ubHkiLAogICAgInRlc3QiOiAidml0ZXN0IHJ1biIsCiAgICAidHlwZWNoZWNrIjogInRzZ28gLS1ub0VtaXQiLAogICAgImxpbnQiOiAib3hsaW50IiwKICAgICJsaW50OmZpeCI6ICJveGxpbnQgLS1maXgiLAogICAgImxpbnQ6dHlwZXMiOiAib3hsaW50IC0tdHlwZS1hd2FyZSIsCiAgICAiZm9ybWF0IjogIm94Zm10IC0td3JpdGUgLiIsCiAgICAiZm9ybWF0OmNoZWNrIjogIm94Zm10IC0tY2hlY2sgLiIsCiAgICAiY2hlY2siOiAibnBtIHJ1biBsaW50ICYmIG5wbSBydW4gZm9ybWF0OmNoZWNrICYmIG5wbSBydW4gdHlwZWNoZWNrICYmIG5wbSB0ZXN0IiwKICAgICJwcmVwdWJsaXNoT25seSI6ICJucG0gcnVuIGNoZWNrICYmIG5wbSBydW4gYnVpbGQgJiYgbnBtIHBhY2sgLS1kcnktcnVuIgogIH0sCiAgImRlcGVuZGVuY2llcyI6IHsKICAgICJwaS1yZXZpZXdlciI6ICJnaXRodWI6emVmbHEvcGktcmV2aWV3ZXIjYWZhNzdlZWRkOWUyOWViYTA5NmJhYTQwNGExZGI4MWE2NTA5ZmY3ZiIKICB9LAogICJkZXZEZXBlbmRlbmNpZXMiOiB7CiAgICAiQHR5cGVzL25vZGUiOiAiXjI0LjAuMCIsCiAgICAiQHR5cGVzY3JpcHQvbmF0aXZlLXByZXZpZXciOiAiNy4wLjAtZGV2LjIwMjYwMzA0LjEiLAogICAgIm94Zm10IjogIjAuMzYuMCIsCiAgICAib3hsaW50IjogIjEuNTEuMCIsCiAgICAib3hsaW50LXRzZ29saW50IjogIl4wLjE2LjAiLAogICAgInZpdGUiOiAiXjguMC43IiwKICAgICJ2aXRlc3QiOiAiXjQuMS4wLWJldGEuNSIKICB9LAogICJidW5kbGVkRGVwZW5kZW5jaWVzIjogWwogICAgInBpLXJldmlld2VyIgogIF0sCiAgImVuZ2luZXMiOiB7CiAgICAibm9kZSI6ICI+PTI0IgogIH0KfQo=", "" + import.meta.url), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}
function assertNodeVersion() {
	const major = Number(process.versions.node.split(".")[0]);
	if (!Number.isInteger(major) || major < 24) throw new Error(`Node.js >=24 is required; current version is ${process.versions.node}.`);
}
function refsFromVersion(version) {
	return {
		base_sha: version.base_commit_sha,
		start_sha: version.start_commit_sha,
		head_sha: version.head_commit_sha
	};
}
async function run(config) {
	validateConfig(config);
	const gitlab = new GitLabClient({
		gitlabUrl: config.gitlabUrl,
		token: config.gitlabToken,
		authHeader: config.gitlabAuthHeader
	});
	const mr = await gitlab.getMergeRequest(config.project, config.mr);
	const version = await gitlab.getLatestVersion(config.project, config.mr);
	await prepareGitHistory(mr.source_branch, mr.target_branch, { cwd: config.cwd });
	const diff = await getMergeDiff(mr.target_branch, { cwd: config.cwd });
	await runPiReviewer(config, {
		cwd: config.cwd,
		diff
	});
	const parsed = parseReviewMarkdownWithWarnings(await readFile(resolve(config.cwd, config.reviewFile), "utf8"));
	for (const warning of parsed.warnings) console.warn(`[gitlab-review] ${warning}`);
	const existing = extractExistingFingerprints(await gitlab.getDiscussions(config.project, config.mr));
	const generated = buildGeneratedComments(parsed.comments, diff, refsFromVersion(version), existing);
	const outputPath = resolve(config.cwd, config.output);
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, JSON.stringify(generated, null, 2), "utf8");
	const newCount = generated.filter((item) => !item.duplicate).length;
	if (config.dryRun || config.noPost) {
		console.log(`Generated ${generated.length} comments, ${newCount} new. Posting disabled.`);
		return {
			generated,
			posted: 0
		};
	}
	const posted = await postGeneratedComments(gitlab, config.project, config.mr, generated);
	console.log(`Posted ${posted} new GitLab MR discussions (${generated.length - posted} duplicates skipped).`);
	return {
		generated,
		posted
	};
}
async function main(argv = process.argv.slice(2)) {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(HELP);
		return;
	}
	if (argv.includes("--version") || argv.includes("-v")) {
		console.log(readVersion());
		return;
	}
	assertNodeVersion();
	await run(resolveConfig(argv));
}
function isDirectRun() {
	const entry = process.argv[1];
	return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}
if (isDirectRun()) main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
//#endregion
export { main, run };

//# sourceMappingURL=cli.js.map