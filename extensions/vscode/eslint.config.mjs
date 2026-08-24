// @ts-check

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '.vscode-test/**',
      'bin/**',
      'out/**',
      'src/daemon/gen/**',
      '*.vsix',
    ],
  },
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.mocha,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
);
