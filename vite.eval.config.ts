import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'vitest/config';

loadDotenv();

export default defineConfig({
  test: {
    include: ['tests/evals/**/*.eval.ts'],
    environment: 'node',
    // Evals call real LLMs — give them generous time
    testTimeout: 120_000,
    hookTimeout: 30_000,
    reporters: process.env.CI ? ['default', 'json'] : ['default'],
    outputFile: {
      json: './test-results/evals.json',
    },
  },
});
