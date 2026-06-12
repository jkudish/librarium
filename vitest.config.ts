import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'tests/integration/**',
      'tests/workers/**',
      'tests/pty/**',
    ],
    testTimeout: 30_000,
  },
});
