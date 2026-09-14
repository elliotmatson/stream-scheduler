import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.turbo/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The plugin boundary must stay message-passing shaped: see docs/plan/01-architecture.md.
    // Plugins may never reach into core, and nothing may smuggle a live object across the host.
    files: ['packages/plugin-*/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@scheduler/core', '@scheduler/core/*'], message: 'Plugins depend on @scheduler/plugin-sdk only.' },
          ],
        },
      ],
    },
  },
)
