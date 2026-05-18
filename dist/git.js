import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function git(args) {
    const { stdout } = await exec('git', args, { maxBuffer: 20 * 1024 * 1024 });
    return stdout;
}
export async function prepareGitHistory(source, target) {
    await git(['fetch', '--no-tags', 'origin', source, target]).catch(() => undefined);
    await git(['fetch', '--unshallow']).catch(() => undefined);
    try {
        await git(['merge-base', `origin/${target}`, 'HEAD']);
    }
    catch (error) {
        throw new Error(`Unable to prepare git history for origin/${target}...HEAD. Set GIT_DEPTH: 0 or ensure source (${source}) and target (${target}) branches are fetchable. ${error instanceof Error ? error.message : ''}`);
    }
}
export async function getMergeDiff(targetBranch) {
    return git(['diff', `origin/${targetBranch}...HEAD`, '--unified=20']);
}
//# sourceMappingURL=git.js.map