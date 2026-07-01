import { cloudflarePool } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/workers/**/*.test.ts'],
    pool: cloudflarePool({}),
    testTimeout: 30_000,
  },
});
