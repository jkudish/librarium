import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-07-07',
      },
    }),
  ],
  test: {
    include: ['tests/workers/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
