import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/**
 * Gera build/icon.ico a partir do PNG de origem.
 *
 * O Windows escolhe o tamanho do ícone conforme o lugar (16px na barra de
 * título, 32px na barra de tarefas, 256px no explorador) e, quando só existe
 * um PNG grande, ele reduz na hora — o resultado no tamanho pequeno fica
 * borrado ou simplesmente não aparece. Um .ico traz todos os tamanhos já
 * rasterizados.
 *
 * O ICO aqui embute PNGs (formato aceito desde o Vista), em vez de bitmaps
 * BMP: é o mesmo que o próprio electron-builder produz e evita ter que
 * escrever a máscara AND de transparência à mão.
 *
 * Rode com: node scripts/make-ico.mjs
 */

const SIZES = [16, 24, 32, 48, 64, 128, 256]

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, '..', 'build', 'icon.png')
const target = path.join(here, '..', 'build', 'icon.ico')

const images = await Promise.all(
  SIZES.map(async (size) => ({
    size,
    png: await sharp(source).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
  })),
)

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reservado
header.writeUInt16LE(1, 2) // 1 = ícone
header.writeUInt16LE(images.length, 4)

const ENTRY_BYTES = 16
let offset = header.length + images.length * ENTRY_BYTES

const entries = images.map(({ size, png }) => {
  const entry = Buffer.alloc(ENTRY_BYTES)
  // 256 é gravado como 0: o campo tem 1 byte só.
  entry.writeUInt8(size === 256 ? 0 : size, 0)
  entry.writeUInt8(size === 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2) // cores da paleta (0 = sem paleta)
  entry.writeUInt8(0, 3) // reservado
  entry.writeUInt16LE(1, 4) // planos de cor
  entry.writeUInt16LE(32, 6) // bits por pixel
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(offset, 12)
  offset += png.length
  return entry
})

await fs.writeFile(target, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]))
console.log(`${path.relative(process.cwd(), target)} — ${images.length} tamanhos: ${SIZES.join(', ')}`)
