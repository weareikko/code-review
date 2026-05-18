import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Config } from './config.js';

import { ReviewerError } from './errors.js';
import { toPiReviewerSeverity, type PiReviewerSeverity } from './types.js';

export interface PiReviewerOptions {
  cwd?: string;
  diff?: string;
  review?: PiReviewFunction;
}

export interface PiReviewOptions {
  cwd?: string;
  diff?: string;
  branch?: string;
  output?: 'terminal' | 'comment' | 'file';
  dryRun?: boolean;
  piApiKey?: string;
  model?: string;
  minSeverity?: PiReviewerSeverity;
}

export type PiReviewFunction = (options: PiReviewOptions) => Promise<void>;

async function resolvePiReviewer(): Promise<PiReviewFunction> {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('pi-reviewer/package.json');
  const reviewModule = pathToFileURL(join(dirname(pkg), 'dist/src/ci/review.js')).href;
  const imported = (await import(reviewModule)) as { review?: unknown };
  if (typeof imported.review !== 'function') {
    throw new ReviewerError('Unable to load pi-reviewer review() from pinned dependency.', {
      hint: 'Run npm install and ensure the pinned pi-reviewer dependency is available.',
    });
  }
  return imported.review as PiReviewFunction;
}

async function ensureReadableFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new ReviewerError(`pi-reviewer did not generate ${path}`, {
      hint: 'Check pi-reviewer logs and ensure the review command completed successfully.',
    });
  }

  const content = await readFile(path, 'utf8');
  if (content.trim().length === 0) {
    throw new ReviewerError(`pi-reviewer generated an empty review file at ${path}`);
  }
}

export async function runPiReviewer(
  config: Config,
  options: PiReviewerOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? config.cwd;
  const review = options.review ?? (await resolvePiReviewer());
  const generatedPath = resolve(cwd, 'pi-review.md');
  const targetPath = resolve(cwd, config.reviewFile);

  try {
    await review({
      cwd,
      diff: options.diff,
      output: 'file',
      model: config.model,
      minSeverity: toPiReviewerSeverity(config.minSeverity),
      piApiKey: config.apiKey,
    });
  } catch (error) {
    throw new ReviewerError('pi-reviewer failed.', {
      cause: error,
      hint: error instanceof Error ? error.message : undefined,
    });
  }

  await ensureReadableFile(generatedPath);

  if (generatedPath !== targetPath) {
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await rename(generatedPath, targetPath);
    } catch {
      const content = await readFile(generatedPath, 'utf8');
      await writeFile(targetPath, content, 'utf8');
    }
  }

  await ensureReadableFile(targetPath);
}
