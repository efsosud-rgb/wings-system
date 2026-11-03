import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The web package needs a DOM; the API and shared packages use the root config.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: false,
    // Same network kill switch as the API and shared packages.
    setupFiles: [
      resolve(import.meta.dirname, '../api/src/test/no-network.ts'),
      resolve(import.meta.dirname, 'src/test/timing.ts'),
    ],
    // Room for findBy/waitFor (src/test/timing.ts) on a busy CI runner.
    testTimeout: 15_000,
  },
});
