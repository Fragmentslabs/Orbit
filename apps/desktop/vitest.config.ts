import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Its own config (and not the one from vite.config.ts) because the tests run in Node,
 * without the Electron plugin and without the React one: loading that config here
 * would drag the whole app build into the suite.
 *
 * The aliases are the same as there — the modules under test import `@shared/*`.
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
    // The suite deals with real git and disk (worktrees, temporary
    // repositories, merges). The default 5s of vitest are too short when the
    // file runs in parallel with the others and the machine saturates: the test blows up
    // in the middle and still leaves a git process holding the temporary folder, which
    // then fails with EPERM in the afterEach.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
