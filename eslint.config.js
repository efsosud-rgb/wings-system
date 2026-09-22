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
      '.claude/**',
      '.agents/**',
      '.codex/**',
      '.github/agents/**',
      '.github/hooks/**',
      '.github/skills/**',
      'packages/studio/src/**',
      'packages/studio/tests/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Personal data must never reach logs or the console (LGPD).
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
);
