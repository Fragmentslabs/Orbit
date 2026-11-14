import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@orbit/shared': path.resolve(__dirname, '../shared/src/index.ts') },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
