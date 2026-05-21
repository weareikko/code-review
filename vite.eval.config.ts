import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load .env in the main process (covers env vars used at config time).
loadDotenv();

export default defineConfig({
  test: {
    include: ['tests/evals/**/*.eval.ts'],
    environment: 'node',
    // Also load .env inside each worker process so that skipIf() calls in
    // describeEval() see the API key at module-evaluation time.
    setupFiles: ['tests/evals/setup.ts'],
    // Evals call real LLMs — give them generous time
    testTimeout: 120_000,
    hookTimeout: 30_000,
    reporters: process.env.CI ? ['default', 'json'] : ['default'],
    outputFile: {
      json: './test-results/evals.json',
    },
  },
});
