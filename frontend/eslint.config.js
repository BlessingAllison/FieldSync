import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NO_DANGEROUS_HTML = {
  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  message: 'Raw HTML injection is forbidden (CSP + PHI safety, ADD §11.1).',
};

export default tseslint.config(
  {
    ignores: ['dist', 'dev-dist', 'coverage', 'playwright-report', 'test-results', '**/*.gen.*'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.sw.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.strict.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': ['error', NO_DANGEROUS_HTML],
      // Durable state lives in IndexedDB (encrypted where it holds PHI), never Web Storage.
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Use an IndexedDB repository (ADD §9).' },
        { name: 'sessionStorage', message: 'Use an IndexedDB repository (ADD §9).' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // core/ is framework-free and runs inside the service worker (ADD D2).
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'react-*', 'zustand', 'zustand/*', 'framer-motion'], message: 'core/ must not depend on UI frameworks.' },
            { group: ['@/features/*', '@/stores/*', '@/ui/*', '@/app/*', '@/pwa/*'], message: 'core/ must not import from UI layers.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'core/ also runs in the service worker; use globalThis/self.' },
        { name: 'document', message: 'core/ also runs in the service worker.' },
        { name: 'localStorage', message: 'Use an IndexedDB repository (ADD §9).' },
        { name: 'sessionStorage', message: 'Use an IndexedDB repository (ADD §9).' },
      ],
    },
  },
  {
    // A route table, not a component module: fast-refresh boundaries do not apply.
    files: ['src/app/router.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: ['src/sw.ts'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['*.config.{ts,js}', 'e2e/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
