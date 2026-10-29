import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Testes de COMPONENTE do app mobile.
 *
 * O app roda no Metro, mas o componente é React puro — o que se testa aqui
 * (parse do fence, fórmulas, estado das entradas, envio) não depende do
 * runtime nativo. Por isso `react-native` resolve para `react-native-web`
 * (que já é dependência do projeto e é o alvo web do app) dentro do jsdom: os
 * mesmos componentes, com DOM de verdade para interrogarmos.
 *
 * Os aliases são os do tsconfig do app — os módulos testados importam
 * `~/…` e `@orbit/shared`.
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
      // Antes de `react-native`, de propósito: o alias é por prefixo, e
      // `react-native` casaria com `react-native-webview` antes desta linha.
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
