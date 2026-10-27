import { cloudflareTest } from '@cloudflare/vitest-plugin';
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
