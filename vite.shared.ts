import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';

/**
 * The shared Vite library build of every package in the monorepo. Each
 * package's `vite.config.ts` calls it with its own entries. It builds ES
 * modules for Node 24, keeps every bare import external (Node built-ins, npm
 * dependencies and the other workspace packages), and injects the package's
 * own name and version as `__PKG_NAME__` / `__PKG_VERSION__`.
 *
 * Type declarations are emitted by `tsgo -p tsconfig.build.json` in each
 * package's build script.
 */
export interface LibraryOptions {
  /** `import.meta.url` of the package's `vite.config.ts`. */
  root: string;
  /** Entry map: output name → path relative to the package root. */
  entry: Record<string, string>;
}

export interface PackageInfo {
  name: string;
  version: string;
}

/** The name and version in the `package.json` of the package directory `dir`. */
export function readPackageInfo(dir: string): PackageInfo {
  return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as PackageInfo;
}

/** The `define` map that the sources read: `__PKG_NAME__` and `__PKG_VERSION__`. */
export function packageDefines(pkg: PackageInfo): Record<string, string> {
  return {
    __PKG_NAME__: JSON.stringify(pkg.name),
    __PKG_VERSION__: JSON.stringify(pkg.version),
  };
}

function isExternal(id: string): boolean {
  if (id.startsWith('node:') || builtinModules.includes(id)) return true;
  // Bare imports: npm dependencies and workspace packages.
  return !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0');
}

export function defineLibrary(options: LibraryOptions): UserConfig {
  const root = fileURLToPath(new URL('.', options.root));
  const entry = Object.fromEntries(
    Object.entries(options.entry).map(([name, path]) => [name, resolve(root, path)]),
  );
  return {
    root,
    define: packageDefines(readPackageInfo(root)),
    build: {
      lib: {
        entry,
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.js`,
      },
      rolldownOptions: {
        external: isExternal,
      },
      outDir: 'dist',
      emptyOutDir: true,
      target: 'node24',
      minify: false,
      sourcemap: true,
    },
  };
}
