import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = path.resolve(__dirname, '../..')
const sharedAliases = {
  '@': path.resolve(__dirname),
  '~': path.resolve(__dirname),
  '@shared': path.resolve(root, 'packages/shared/src'),
  '@orbit/shared': path.resolve(root, 'packages/shared/src/index.ts'),
  '@orbit/shared/': path.resolve(root, 'packages/shared/src'),
}

export default defineConfig({
  resolve: {
    alias: sharedAliases,
  },
  plugins: [
    tailwindcss(),
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        // No-op onstart: keeps the renderer dev server alive without launching Electron.
        onstart: () => {},
        vite: {
          resolve: { alias: sharedAliases },
          build: {
            rollupOptions: {
              external: ['node-pty', 'pdf-parse', '@napi-rs/canvas'],
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      renderer: {},
    }),
  ],
  server: { port: 5199, strictPort: true },
})
