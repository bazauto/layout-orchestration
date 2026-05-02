// @ts-check
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

const sharedTsRules = {
  ...tsPlugin.configs.recommended.rules,
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  // TypeScript already catches undefined-variable errors more accurately than
  // ESLint's no-undef, which has no knowledge of TS type declarations / namespaces.
  'no-undef': 'off',
};

export default [
  js.configs.recommended,
  // ── Backend (Node.js) ────────────────────────────────────────────────────────
  {
    files: ['packages/backend/src/**/*.ts', 'packages/backend/tests/**/*.ts'],
    plugins: { '@typescript-eslint': tsPlugin },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { ...globals.node },
    },
    rules: {
      ...sharedTsRules,
      // Backend startup / structured logging via console is intentional; a Pino
      // migration can enforce this rule later once the logger is wired up.
      'no-console': 'off',
    },
  },
  // ── Frontend (browser + React) ───────────────────────────────────────────────
  {
    files: ['packages/frontend/src/**/*.{ts,tsx}'],
    plugins: { '@typescript-eslint': tsPlugin },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser },
    },
    rules: {
      ...sharedTsRules,
      'no-console': 'warn',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', 'eslint.config.js'],
  },
];
