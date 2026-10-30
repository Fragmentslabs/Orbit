// Generates the tiles of the MSIX/AppX package from public/icon.png.
//
// electron-builder does NOT derive the AppX assets from the `icon` of the config: it
// looks for `build/appx/*.png` and, when it does not find them, falls back to the SampleAppx.*.png
// of the winCodeSign vendor — which are the Electron logo. That is how Orbit
// went up to the Microsoft Store with the Electron atom in the listing.
//
// Runs before `electron-builder` in the build:store script; the output is derived
// (stays out of git), so it needs to be regenerated on every build.
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'public', 'icon.png')
const outDir = path.join(root, 'build', 'appx')

// Same #18181B as the background of icon.png: the wide tiles need to complete the
// frame without clashing with the square of the icon.
const background = { r: 24, g: 24, b: 27, alpha: 1 }

// Exact names that AppxTarget maps to the manifest — renaming breaks the
// binding and the Electron default comes back in its place.
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
  // The icon comes in centered and with clearance: stretching it to 310x150 would deform the ring.
  const inner = Math.round(height * 0.72)
  const icon = await sharp(source).resize(inner, inner, { fit: 'cover' }).png().toBuffer()
  await sharp({ create: { width, height, channels: 4, background } })
    .composite([{ input: icon, gravity: 'centre' }])
    .png()
    .toFile(path.join(outDir, name))
}

const generated = [...Object.keys(square), ...Object.keys(wide)]
console.log(`[generate-appx-assets] ${generated.length} assets in build/appx: ${generated.join(', ')}`)
