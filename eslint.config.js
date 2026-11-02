import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { noAsyncReplyReturn } from './apps/api/src/lint/no-async-reply-return.ts';

export default tseslint.config(
  // .claude/, .agents/ and .github/agents|hooks|skills hold third-party agent
  // skills, vendored as published (some installers mirror the same skill into
  // several agent harnesses): not ours to lint.
  // packages/studio/src and tests are a vendored fork (see its NOTICE.md), kept diffable against upstream.
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      // Official brand module, byte-exact to the hand-off (sha256 in docs); never reformatted or edited here
      'apps/web/src/brand/wings-logo3d.js',
      // Reference 3D charts module from Eric's canvas, byte-exact (sha256 665138ea…); the app's port lives in components/charts3d
      'docs/referencias/wings-charts3d.js',
      '.claude/**',
      '.agents/**',
      '.codex/**',
      '.github/agents/**',
      '.github/hooks/**',
      '.github/skills/**',
      // One-off Google Tag Manager scripts (not product code; they run by hand, once): not linted.
      'scripts/gtm/**',
      'packages/studio/src/**',
      'packages/studio/tests/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // The landing pages' Node scripts and e2e runner; their page.evaluate callbacks run in the browser.
    files: ['apps/landing/scripts/**/*.mjs', 'apps/landing/e2e/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'Buffer',
          'console',
          'process',
          'setTimeout',
          'URL',
          'document',
          'Image',
          'performance',
          'PerformanceObserver',
          'requestAnimationFrame',
          'window',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
  {
    // The API's end-to-end runner and flows (pnpm e2e): plain Node scripts.
    files: ['apps/api/e2e/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        ['console', 'fetch', 'process', 'setTimeout', 'URL'].map((name) => [name, 'readonly']),
      ),
    },
  },
  {
    // The repository's own rules (apps/api/src/lint/).
    plugins: { wings: { rules: { 'no-async-reply-return': noAsyncReplyReturn } } },
    rules: {
      'wings/no-async-reply-return': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Personal data must never reach logs or the console (LGPD).
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
);
