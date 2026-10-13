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
      index: 'src/public-entry.ts',
      core: 'src/run-core-entry.ts',
      node: 'src/run-node-entry.ts',
      testing: 'src/testing-entry.ts',
      maintainer: 'src/maintainer-entry.ts',
    },
    // Core remains runtime-neutral; root/node load filesystem configuration.
    // The packed metafile/chunk gate proves core cannot reach Node builtins.
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
    define: {
      ...shared.define,
      __BUNDLED_SKILL__: JSON.stringify(readFileSync('./SKILL.md', 'utf8')),
    },
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
