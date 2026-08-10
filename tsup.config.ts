import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const shared: Options = {
  format: ['esm'],
  target: 'node22.12',
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
  // The `core` and `node` entries MUST be built together with code splitting
  // enabled so the shared provider registry (`src/adapters/index.ts`) becomes a
  // single common chunk imported by BOTH dist/core.js and dist/node.js.
  //
  // Built separately (the previous setup), each entry inlined its own private
  // copy of the registry Map. `registerCustomProviders()` from `librarium/node`
  // then wrote to the node bundle's registry while `getProvider()`/`dispatch()`
  // from `librarium/core` read the core bundle's separate registry, so the
  // documented "import core for dispatch + node for custom providers" flow
  // silently did nothing. Splitting within one build context fixes this because
  // tsup/esbuild only shares modules that are reachable from multiple entries.
  //
  // Platform is `neutral`: core's reachable graph is edge-safe, and the
  // Node-only code reachable only from `node-entry` (custom.ts -> child_process
  // etc.) stays isolated in the node-specific chunk. Node built-ins resolve
  // fine under the esm/node22.12 target. The shared chunk reachable from core must
  // remain free of Node-only APIs -- the workers test guards this.
  {
    ...shared,
    entry: {
      core: 'src/core-entry.ts',
      node: 'src/node-entry.ts',
    },
    platform: 'neutral',
    splitting: true,
    clean: false,
  },
]);
