import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .claude/ holds third-party agent skills, vendored as published: not ours to lint.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.claude/**'] },
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
