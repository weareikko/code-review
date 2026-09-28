import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import EvalReporter from 'vitest-evals/reporter';
import { defineConfig } from 'vitest/config';

// Load .env in the main process (covers env vars used at config time).
loadDotenv();

// `src/mcp.ts` reads the build-time `__PKG_VERSION__` define (the MCP client
// identifies itself to every server it connects to), so evals that connect a
// server need the same define the library build injects.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string };

export default defineConfig({
  define: {
    __PKG_NAME__: JSON.stringify(pkg.name),
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ['tests/evals/**/*.eval.ts'],
    environment: 'node',
    // Also load .env inside each worker process so that skipIf() calls in
    // describeEval() see the API key at module-evaluation time.
    setupFiles: ['tests/evals/setup.ts'],
    // Evals call real LLMs — give them generous time
    testTimeout: 120_000,
    hookTimeout: 30_000,
    reporters: process.env.CI ? [new EvalReporter(), 'json'] : [new EvalReporter()],
    outputFile: {
      json: './test-results/evals.json',
    },
  },
});
