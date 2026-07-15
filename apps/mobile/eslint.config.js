// https://docs.expo.dev/guides/using-eslint/
const { createRequire } = require('node:module')
const expoRequire = createRequire(require.resolve('eslint-config-expo/default.js'))

const expoPlugin = require('eslint-plugin-expo')
const importPlugin = expoRequire('eslint-plugin-import')
const tsPlugin = expoRequire('@typescript-eslint/eslint-plugin')
const tsParser = expoRequire('@typescript-eslint/parser')
const reactPlugin = expoRequire('eslint-plugin-react')
const reactHooksPlugin = expoRequire('eslint-plugin-react-hooks')
const globals = require('globals')

const jsExtensions = ['.js', '.jsx', '.cjs', '.mjs']
const tsExtensions = ['.ts', '.tsx', '.d.ts']
const allExtensions = [...jsExtensions, ...tsExtensions]
const importIgnore = 'node_modules[\\/]+@?react-native'

module.exports = [
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.errors,

  { ignores: ['android/app/build'] },
  {
    plugins: { expo: expoPlugin },
    rules: {
      'expo/use-dom-exports': 'error',
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',
    },
  },

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { impliedStrict: true, jsx: true },
      },
    },
    settings: {
      'import/ignore': [importIgnore],
      'import/extensions': jsExtensions,
      'import/resolver': {
        node: { extensions: jsExtensions },
        typescript: true,
      },
    },
    rules: {
      eqeqeq: ['warn', 'smart'],
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty-character-class': 'warn',
      'no-empty-pattern': 'warn',
      'no-extend-native': 'warn',
      'no-extra-bind': 'warn',
      'no-redeclare': 'warn',
      'no-undef': 'error',
      'no-unreachable': 'warn',
      'no-unsafe-negation': 'warn',
      'no-unused-expressions': ['warn', { allowShortCircuit: true, enforceForJSX: true }],
      'no-unused-labels': 'warn',
      'no-unused-vars': ['warn', { vars: 'all', args: 'none', ignoreRestSiblings: true, caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }],
      'no-with': 'warn',
      'unicode-bom': ['warn', 'never'],
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'import/first': 'warn',
      'import/default': 'off',
      'no-var': 'error',
    },
  },
  { files: ['**/*.d.ts'], rules: { 'import/order': 'off' } },
  { files: ['**/metro.config.js'], languageOptions: { globals: globals.node } },

  importPlugin.flatConfigs.typescript,
  {
    files: ['**/*.js', '**/*.jsx'],
    settings: {
      'import/parsers': { '@typescript-eslint/parser': tsExtensions },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.d.ts'],
    plugins: { '@typescript-eslint': tsPlugin },
    languageOptions: { parser: tsParser },
    settings: {
      'import/extensions': allExtensions,
      'import/parsers': { '@typescript-eslint/parser': tsExtensions },
      'import/resolver': { node: { extensions: allExtensions } },
    },
    rules: {
      '@typescript-eslint/array-type': ['warn', { default: 'array' }],
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
      '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow' }],
      '@typescript-eslint/no-extra-non-null-assertion': 'warn',
      'no-dupe-class-members': 'off',
      '@typescript-eslint/no-dupe-class-members': 'error',
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': 'warn',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { vars: 'all', args: 'none', ignoreRestSiblings: true, caughtErrors: 'all' }],
      'no-useless-constructor': 'off',
      '@typescript-eslint/no-useless-constructor': 'warn',
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': ['warn', { allow: ['\\.(aac|aiff|avif|bmp|caf|db|gif|heic|html|jpeg|jpg|json|m4a|m4v|mov|mp3|mp4|mpeg|mpg|otf|pdf|png|psd|svg|ttf|wav|webm|webp|xml|yaml|yml|zip)$'] }],
    },
  },

  {
    plugins: { react: reactPlugin, 'react-hooks': reactHooksPlugin },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/no-unknown-property': 'warn',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/jsx-no-target-blank': 'off',
      'react/no-this-in-sfc': 'warn',
    },
  },

  { ignores: ['dist/*'] },
]
