import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const shared: Options = {
  format: ['esm'],
  target: 'node22.12',
  outDir: 'dist',
  sourcemap: true,
  // TS7 owns source checking and declaration output. Keep tsup away from its
  // removed JS compiler API by disabling declaration generation here.
  dts: false,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
};

export default defineConfig([
  {
    ...shared,
    entry: {
      index: 'src/index.ts',
      core: 'src/core-entry.ts',
      node: 'src/node-entry.ts',
    },
    // One neutral build context lets root/core/node share the exact same
    // Worker-safe chunks. Node-only builtins remain external imports reachable
    // exclusively from node.js; Node ESM accepts their bare specifiers. The
    // packed metafile/chunk gate proves root and core cannot reach them.
    platform: 'neutral',
    splitting: true,
    clean: false,
  },
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    platform: 'node',
    splitting: false,
    clean: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
