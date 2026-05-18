import { readFile, writeFile } from 'node:fs/promises';
import { helpText, resolveConfig, validateConfig } from './config.js';
import { GitLabClient } from './gitlab.js';
import { getMergeDiff, prepareGitHistory } from './git.js';
import { runPiReviewer } from './pi-reviewer.js';
import { appendFingerprintMarkers, buildPayload, extractDiffHunkContext, extractExistingFingerprints, fingerprints, parseReviewMarkdown } from './review.js';
export async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(helpText());
        return;
    }
    const config = resolveConfig();
    validateConfig(config);
    const gitlab = new GitLabClient({ gitlabUrl: config.gitlabUrl, token: config.gitlabToken });
    const mr = await gitlab.getMergeRequest(config.project, config.mr);
    const version = await gitlab.getLatestVersion(config.project, config.mr);
    await prepareGitHistory(mr.source_branch, mr.target_branch);
    await runPiReviewer(config);
    const review = await readFile(config.reviewFile, 'utf8');
    const comments = parseReviewMarkdown(review);
    const diff = await getMergeDiff(mr.target_branch);
    const discussions = await gitlab.getDiscussions(config.project, config.mr);
    const existing = extractExistingFingerprints(discussions);
    const generated = comments.map((comment) => {
        const hunk = extractDiffHunkContext(diff, comment.file, comment.line, comment.side);
        const fp = fingerprints(comment, hunk);
        const duplicate = existing.has(fp.primary) || existing.has(fp.secondary);
        return { comment, fingerprints: fp, duplicate, payload: buildPayload(comment, appendFingerprintMarkers(comment.body, fp), {
                base_sha: version.base_commit_sha, start_sha: version.start_commit_sha, head_sha: version.head_commit_sha,
            }) };
    });
    await writeFile(config.output, JSON.stringify(generated, null, 2), 'utf8');
    const toPost = generated.filter((item) => !item.duplicate);
    if (config.dryRun || config.noPost) {
        console.log(`Generated ${generated.length} comments, ${toPost.length} new. Posting disabled.`);
        return;
    }
    for (const item of toPost)
        await gitlab.postDiscussion(config.project, config.mr, item.payload);
    console.log(`Posted ${toPost.length} new GitLab MR discussions (${generated.length - toPost.length} duplicates skipped).`);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map