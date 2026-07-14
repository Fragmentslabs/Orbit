/**
 * Shared ESLint config for all Orbit workspaces.
 * Each workspace extends this via:
 *   extends: ["../../.eslintrc.base.cjs"]
 */
module.exports = {
  root: true,
  env: { es2020: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  ignorePatterns: ['node_modules', 'dist', 'dist-electron', '.expo'],
}
