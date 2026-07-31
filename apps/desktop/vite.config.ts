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

// https://vitejs.dev/config/
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
        vite: {
          resolve: {
            alias: sharedAliases,
          },
          build: {
            rollupOptions: {
              // pdf-parse (via pdfjs-dist) resolve seu worker.mjs num caminho
              // relativo ao próprio arquivo em runtime — empacotado num único
              // bundle, esse caminho relativo passa a apontar para dentro de
              // dist-electron/, onde o worker não existe. Externalizar deixa
              // o require apontar pro node_modules real, preservando os
              // caminhos relativos entre os arquivos do pacote.
              external: ['node-pty', 'pdf-parse'],
            },
          },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
  ],
})
