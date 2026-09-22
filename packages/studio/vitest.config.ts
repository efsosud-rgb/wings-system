import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { aliases } from './vite.shared';

// The upstream suite was written for Jest; tests/setup.ts maps the parts it
// uses onto Vitest. Same network kill switch as the rest of the monorepo.
export default defineConfig({
  resolve: { alias: aliases(import.meta.dirname) },
  test: {
    environment: 'jsdom',
    globals: true,
    css: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: [
      resolve(import.meta.dirname, '../../apps/api/src/test/no-network.ts'),
      resolve(import.meta.dirname, 'tests/setup.ts'),
    ],
  },
});
