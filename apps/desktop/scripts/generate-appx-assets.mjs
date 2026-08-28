// Gera os ladrilhos (tiles) do pacote MSIX/AppX a partir de public/icon.png.
//
// O electron-builder NÃO deriva os assets do AppX do `icon` da config: ele
// procura por `build/appx/*.png` e, quando não acha, cai nos SampleAppx.*.png
// do vendor winCodeSign — que são o logo do Electron. Foi assim que o Orbit
// subiu para a Microsoft Store com o átomo do Electron na listagem.
//
// Roda antes do `electron-builder` no script build:store; a saída é derivada
// (fica fora do git), então precisa ser regerada a cada build.
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'public', 'icon.png')
const outDir = path.join(root, 'build', 'appx')

// Mesmo #18181B do fundo do icon.png: os ladrilhos largos precisam completar a
// moldura sem emendar com o quadrado do ícone.
const background = { r: 24, g: 24, b: 27, alpha: 1 }

// Nomes exatos que o AppxTarget mapeia para o manifesto — renomear quebra o
// vínculo e o default do Electron volta a entrar no lugar.
const square = {
  'Square44x44Logo.png': 44,
  'StoreLogo.png': 50,
  'SmallTile.png': 71,
  'Square150x150Logo.png': 150,
  'LargeTile.png': 310,
}
const wide = {
  'Wide310x150Logo.png': [310, 150],
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const [name, size] of Object.entries(square)) {
  await sharp(source).resize(size, size, { fit: 'cover' }).png().toFile(path.join(outDir, name))
}

for (const [name, [width, height]] of Object.entries(wide)) {
  // O ícone entra centralizado e com folga: esticá-lo até 310x150 deformaria o anel.
  const inner = Math.round(height * 0.72)
  const icon = await sharp(source).resize(inner, inner, { fit: 'cover' }).png().toBuffer()
  await sharp({ create: { width, height, channels: 4, background } })
    .composite([{ input: icon, gravity: 'centre' }])
    .png()
    .toFile(path.join(outDir, name))
}

const generated = [...Object.keys(square), ...Object.keys(wide)]
console.log(`[generate-appx-assets] ${generated.length} assets em build/appx: ${generated.join(', ')}`)
