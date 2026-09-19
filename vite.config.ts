import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const external = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  'yaml',
  'isomorphic-git',
  'diff',
  'typebox',
  /^@earendil-works\//,
  /^@opentelemetry\//,
  /^@grpc\//,
];

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string };

export default defineConfig({
  define: {
    __PKG_NAME__: JSON.stringify(pkg.name),
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    lib: {
      entry: {
        cli: './src/cli.ts',
        review: './src/review.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external,
    },
    target: 'node24',
    minify: false,
    sourcemap: true,
  },
  test: {
    environment: 'node',
    // Restrict collection to this project's own tests. The SWE-PRBench eval
    // fixtures materialize real upstream checkouts (vitest, stylelint, zod, …)
    // under tests/evals/fixtures/, which ship thousands of their own *.test.ts;
    // the default glob would otherwise run those instead.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/evals/fixtures/**'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: {
      junit: './test-results/junit.xml',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts', 'src/types.ts'],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 65,
        lines: 70,
      },
    },
  },
});
