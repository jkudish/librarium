import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/workers/**'],
    testTimeout: 30_000,
  },
});
