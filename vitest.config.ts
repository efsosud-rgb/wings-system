import { defineConfig } from 'vitest/config';

// Shared defaults for every workspace package: never run compiled output.
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
