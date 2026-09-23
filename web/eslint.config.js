// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');
const prettier = require('eslint-config-prettier');

module.exports = defineConfig([
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 20],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // No-op callbacks are deliberate (swallowed errors, stub handlers in specs).
      '@typescript-eslint/no-empty-function': 'off',
      // The log viewer strips ANSI escapes and control characters by regex.
      'no-control-regex': 'off',
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: {
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ':matches(CallExpression[callee.name=/^(test|it|describe)$/], CallExpression[callee.object.name=/^(test|it|describe)$/], CallExpression[callee.callee.object.name=/^(test|it|describe)$/]) > Literal.arguments:first-child[value.length>80]',
          message: 'Keep test titles to 80 characters.',
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      // The sign-in and first-run forms have one field; focusing it is the point.
      '@angular-eslint/template/no-autofocus': 'off',
    },
  },
  prettier,
]);
