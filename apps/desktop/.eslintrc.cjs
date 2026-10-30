module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    // Turned off on purpose: it is a granularity hint of Fast Refresh
    // (dev), with no effect in production, and the repository violates its premise by
    // architecture decision — provider and its hook in the same file
    // (theme-provider/useTheme, workspace-context/useWorkspace) and components
    // of shadcn along with its variants (button/buttonVariants). Complying with it
    // would require breaking 19 files in two, including the vendored ones from
    // shadcn and ai-elements, which would then diverge from upstream.
    'react-refresh/only-export-components': 'off',
    // The "_" prefix and rest siblings mark DELIBERATE discarding — the common case
    // it is destructuring a single prop so that it does not leak into the {...props} of a
    // DOM element (React warns on an unknown attribute).
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
}
