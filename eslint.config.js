import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

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
    // A deadline rounded to the minute, recomputed from a row's created_at, compares two instants:
    // the database stamps created_at at the start of its transaction, the code read its own clock
    // later (CI of PR #67, 30/10/2026). Stop the clock and use that instant (apps/api/src/test/clock.ts).
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name=/^(addBusinessHours|nextBusinessInstant|endOfBusinessDay)$/][arguments.0.property.name='createdAt']",
          message:
            'Expected deadline from created_at (database clock): stop the clock with freezeClockAtMinuteEnd and compute it from that instant.',
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Personal data must never reach logs or the console (LGPD).
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
);
