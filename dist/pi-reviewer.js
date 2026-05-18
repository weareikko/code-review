import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toPiReviewerSeverity } from './types.js';
async function resolvePiReviewer() {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('pi-reviewer/package.json');
    const reviewModule = pathToFileURL(join(dirname(pkg), 'dist/src/ci/review.js')).href;
    const imported = (await import(reviewModule));
    if (typeof imported.review !== 'function') {
        throw new Error('Unable to load pi-reviewer review() from pinned dependency.');
    }
    return imported.review;
}
async function ensureReadableFile(path) {
    try {
        await access(path);
    }
    catch {
        throw new Error(`pi-reviewer did not generate ${path}`);
    }
    const content = await readFile(path, 'utf8');
    if (content.trim().length === 0) {
        throw new Error(`pi-reviewer generated an empty review file at ${path}`);
    }
}
export async function runPiReviewer(config, options = {}) {
    const cwd = options.cwd ?? config.cwd;
    const review = options.review ?? (await resolvePiReviewer());
    const generatedPath = resolve(cwd, 'pi-review.md');
    const targetPath = resolve(cwd, config.reviewFile);
    await review({
        cwd,
        diff: options.diff,
        output: 'file',
        model: config.model,
        minSeverity: toPiReviewerSeverity(config.minSeverity),
        piApiKey: config.apiKey,
    });
    await ensureReadableFile(generatedPath);
    if (generatedPath !== targetPath) {
        await mkdir(dirname(targetPath), { recursive: true });
        try {
            await rename(generatedPath, targetPath);
        }
        catch {
            const content = await readFile(generatedPath, 'utf8');
            await writeFile(targetPath, content, 'utf8');
        }
    }
    await ensureReadableFile(targetPath);
}
//# sourceMappingURL=pi-reviewer.js.map