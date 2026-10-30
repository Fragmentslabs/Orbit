import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/**
 * Generates build/icon.ico from the source PNG.
 *
 * Windows chooses the icon size according to the place (16px in the title
 * bar, 32px in the taskbar, 256px in the explorer) and, when there is only
 * one large PNG, it shrinks it on the fly — the result at the small size comes out
 * blurry or simply does not appear. An .ico brings all the sizes already
 * rasterized.
 *
 * The ICO here embeds PNGs (format accepted since Vista), instead of BMP
 * bitmaps: it is the same as what electron-builder itself produces and avoids having to
 * write the AND transparency mask by hand.
 *
 * Run with: node scripts/make-ico.mjs
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
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // 1 = icon
header.writeUInt16LE(images.length, 4)

const ENTRY_BYTES = 16
let offset = header.length + images.length * ENTRY_BYTES

const entries = images.map(({ size, png }) => {
  const entry = Buffer.alloc(ENTRY_BYTES)
  // 256 is written as 0: the field has only 1 byte.
  entry.writeUInt8(size === 256 ? 0 : size, 0)
  entry.writeUInt8(size === 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2) // palette colors (0 = no palette)
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(offset, 12)
  offset += png.length
  return entry
})

await fs.writeFile(target, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]))
console.log(`${path.relative(process.cwd(), target)} — ${images.length} sizes: ${SIZES.join(', ')}`)
