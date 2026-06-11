import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const shared: Options = {
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  dts: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
};

export default defineConfig([
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    platform: 'node',
    clean: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    ...shared,
    entry: { core: 'src/core-entry.ts' },
    platform: 'neutral',
    clean: false,
  },
]);
