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
  },
});
