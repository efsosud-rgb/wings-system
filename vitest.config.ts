import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Shared defaults for every workspace package: never run compiled output.
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Hard network kill switch: Wings has no sandbox ad accounts, so no test
    // may ever be able to reach a live platform. See apps/api/src/test/no-network.ts
    // Absolute: setupFiles resolve against each package's root, not this file.
    setupFiles: [resolve(import.meta.dirname, 'apps/api/src/test/no-network.ts')],
    // A beforeAll that migrates a throwaway database (100+ migrations) passed 10 s on a busy runner.
    hookTimeout: 60_000,
  },
});
