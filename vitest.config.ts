import { fileURLToPath } from 'node:url';
import { defaultExclude, defineConfig } from 'vitest/config';
import { packageDefines, readPackageInfo } from './vite.shared.ts';

const packageDir = (name: string) => fileURLToPath(new URL(`./packages/${name}/`, import.meta.url));

// Tests import the sources of the other workspace packages, not their build:
// `npm test` works on a fresh clone, before `npm run build`.
const alias = {
  '@weareikko/agent-context': fileURLToPath(
    new URL('./packages/agent-context/src/index.ts', import.meta.url),
  ),
};

// One project per package. `define` must be set in each project: a top-level
// `define` does not reach the projects. Evals (`*.eval.ts`, real LLM calls)
// run from packages/code-review/vite.eval.config.ts instead.
const project = (name: string, exclude: string[] = []) => ({
  define: packageDefines(readPackageInfo(packageDir(name))),
  resolve: { alias },
  test: {
    name,
    root: packageDir(name),
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: [...defaultExclude, ...exclude],
    environment: 'node' as const,
  },
});

export default defineConfig({
  test: {
    projects: [
      project('agent-context'),
      // Materialized benchmark repos live here and carry their own test suites.
      project('code-review', ['tests/evals/fixtures/**']),
    ],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: {
      junit: './test-results/junit.xml',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/agent-context/src/index.ts',
        'packages/code-review/src/cli.ts',
        'packages/code-review/src/types.ts',
      ],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 65,
        lines: 70,
      },
    },
  },
});
