import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // TypeORM entities/DTOs legitimately use `any` at (de)serialization
      // boundaries; tighten per-module later rather than blanket-ban now.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
