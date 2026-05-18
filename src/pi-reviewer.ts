import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Config } from './config.js';

export async function runPiReviewer(config: Config): Promise<void> {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('pi-reviewer/package.json');
  const bin = join(dirname(pkg), 'dist/src/ci/bin.js');
  const args = [bin, '--model', config.model, '--min-severity', config.minSeverity];
  const env = { ...process.env, PI_API_KEY: config.apiKey, ANTHROPIC_API_KEY: config.apiKey };
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`pi-reviewer failed with exit code ${code}`)));
  });
  await writeFile(config.reviewFile, output, 'utf8');
}
