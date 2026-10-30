import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * COMPONENT tests of the mobile app.
 *
 * The app runs on Metro, but the component is pure React — what is tested here
 * (fence parsing, formulas, state of the inputs, sending) does not depend on the
 * native runtime. That is why `react-native` resolves to `react-native-web`
 * (which is already a dependency of the project and is the web target of the app) inside jsdom: the
 * same components, with a real DOM to interrogate.
 *
 * The aliases are the ones of the app's tsconfig — the modules under test import
 * `~/…` and `@orbit/shared`.
 */
const root = path.resolve(__dirname, '../..')

export default defineConfig({
  resolve: {
    alias: {
      '~assets': path.resolve(__dirname, 'assets'),
      '~': path.resolve(__dirname, 'src'),
      '@orbit/shared': path.resolve(root, 'packages/shared/src/index.ts'),
      react: path.resolve(root, 'node_modules/react'),
      'react-dom': path.resolve(root, 'node_modules/react-dom'),
      // Before `react-native`, on purpose: the alias is by prefix, and
      // `react-native` would match `react-native-webview` before this line.
      'react-native-webview': path.resolve(__dirname, 'src/test/webview-stub.tsx'),
      'react-native': path.resolve(root, 'node_modules/react-native-web'),
    },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/components/chat/OrbitUi/test-env.ts'],
    testTimeout: 20_000,
  },
})
