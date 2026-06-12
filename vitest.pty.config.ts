import { defineConfig } from 'vitest/config';

/**
 * PTY smoke suite — runs the BUILT cli (`dist/cli.js`) inside a real
 * pseudo-terminal. Kept out of the default `vitest run` (vitest.config.ts
 * excludes tests/pty) and driven via `npm run test:pty`, which builds first.
 *
 * Single-threaded: each test spawns and drives a real terminal child, and the
 * mock script providers fork their own processes. Serializing keeps the PTY
 * output streams unambiguous and avoids resource contention / flake.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/pty/**/*.test.ts'],
    // Fail fast if dist/ is missing (the suite drives the built CLI).
    globalSetup: ['tests/pty/global-setup.ts'],
    // Real PTYs + child processes per case; give them headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Drive terminals one at a time for deterministic output capture.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    fileParallelism: false,
  },
});
