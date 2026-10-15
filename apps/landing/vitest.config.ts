import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// The page's pure modules run in Node; the browser checks are e2e/run.mjs (pnpm test:e2e).
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: false,
    // Same network kill switch as the API, shared and web packages.
    setupFiles: [resolve(import.meta.dirname, '../api/src/test/no-network.ts')],
  },
});
