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
    // A suíte mexe com git e disco de verdade (worktrees, repositórios
    // temporários, merges). Os 5s padrão do vitest são curtos demais quando o
    // arquivo roda em paralelo com os outros e a máquina satura: o teste estoura
    // no meio e ainda deixa um processo do git segurando a pasta temporária, que
    // então falha com EPERM no afterEach.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
