import { builtinModules } from 'node:module';
import { defineConfig } from 'vitest/config';

const external = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  'pi-reviewer',
];

export default defineConfig({
  build: {
    lib: {
      entry: {
        cli: './src/cli.ts',
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
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: {
      junit: './test-results/junit.xml',
    },
  },
});
