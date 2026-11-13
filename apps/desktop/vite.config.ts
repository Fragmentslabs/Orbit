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
  '@orbit/companion-client': path.resolve(root, 'packages/companion-client/src/index.ts'),
}

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: sharedAliases,
  },
  build: {
    rollupOptions: {
      // Second renderer page: the floating Computer Use panels
      // (conversation + actions over other apps). Its own entry so as not to
      // load the synchronizers of the main window (queue, phone).
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'computer-panels': path.resolve(__dirname, 'computer-panels.html'),
        // Overlay of the global shortcut (⇧⌘space): its own page so the panel
        // opens only with what it needs — without the synchronizers of the main one.
        overlay: path.resolve(__dirname, 'overlay.html'),
      },
    },
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
              // pdf-parse (via pdfjs-dist) resolves its worker.mjs to a path
              // relative to the file itself at runtime — packed into a single
              // bundle, that relative path starts pointing inside
              // dist-electron/, where the worker does not exist. Externalizing leaves
              // the require point to the real node_modules, preserving the
              // relative paths between the files of the package. The
              // @napi-rs/canvas is also externalized: it is a native module
              // (.node), impossible to bundle, and it is used to polyfill the
              // DOMMatrix required by pdfjs-dist.
              //
              // onnxruntime-node is the runtime of the local TTS: native (.node + the
              // libonnxruntime), loaded by the child process of the voice engine
              // (electron/voice-engine). It stays out of the bundle for the same reason
              // as canvas — and because the one that imports it is the child process, not
              // this bundle; externalizing guarantees that it stays that way.
              external: ['node-pty', 'pdf-parse', '@napi-rs/canvas', 'onnxruntime-node'],
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
