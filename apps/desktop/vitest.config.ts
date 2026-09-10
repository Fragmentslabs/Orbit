import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Config própria (e não a do vite.config.ts) porque os testes rodam em Node,
 * sem o plugin do Electron nem o do React: carregar aquele config aqui
 * arrastaria o build inteiro do app para dentro da suíte.
 *
 * Os aliases são os mesmos de lá — os módulos testados importam `@shared/*`.
 */
const root = path.resolve(__dirname, '../..')

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      '~': path.resolve(__dirname),
      '@shared': path.resolve(root, 'packages/shared/src'),
      '@orbit/shared': path.resolve(root, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'lib/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
