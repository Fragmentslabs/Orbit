// Esvazia o `dist-electron/` ANTES do build.
//
// O `vite-plugin-electron` desliga o `emptyOutDir` do Vite de propósito
// (ver node_modules/vite-plugin-electron/dist/index.js:47): main e preload
// escrevem no MESMO diretório, então esvaziar a cada build faria o segundo
// apagar a saída do primeiro. O efeito colateral é que o build do main nunca
// descarta a rodada anterior — cada execução deixa os chunks velhos
// (main-*.js, index-*.js, token-*.js, sempre com hash novo) conviverem com os
// novos. Por isso ligar `emptyOutDir: true` na config do Vite não é a solução:
// quebraria o build e, em dev/watch, apagaria os arquivos debaixo do Electron
// em execução.
//
// Como `dist-electron` está no `files` do electron-builder, esse lixo acumulado
// entra inteiro dentro do app.asar. Medido nesta árvore antes desta correção:
// 703 MB, 824 arquivos, 274 chunks `token-*.js`, com arquivos de 15/ago a
// 10/set convivendo — contra 4,6 MB de um clone recém-instalado. O DMG arm64
// saiu 402 MB, contra 254 MB do x64, que fora buildado do zero.
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolvido a partir da localização do script (não do cwd), porque no CI o
// build entra por `npm run build:linux --workspace=@orbit/desktop`.
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(appDir, 'dist-electron')

// Guarda contra apagar o diretório errado se o script for movido de lugar.
if (path.basename(appDir) !== 'desktop' || path.basename(target) !== 'dist-electron') {
  console.error(`[clean-electron-output] caminho inesperado (${target}); abortando.`)
  process.exit(1)
}

if (!existsSync(target)) {
  console.log('[clean-electron-output] dist-electron já está ausente; nada a fazer.')
  process.exit(0)
}

rmSync(target, { recursive: true, force: true })
console.log('[clean-electron-output] dist-electron removido.')
