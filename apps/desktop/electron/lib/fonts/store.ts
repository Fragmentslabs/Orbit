import { app, protocol } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { FONT_SCHEME } from '@shared/media'
import { withAssetLock, writeFileAtomic } from '../asset-lock'

/**
 * Orbit's font library: `orbit-data/fonts` (index + `files/`) and the `orbit-font://`
 * scheme that serves it.
 *
 * The store is CONTENT-ADDRESSED (the file name is the hash of the content):
 * downloading the same family twice, or two families that share a subset, does not
 * duplicate a single byte. The index keeps what the UI and the agent need to know in
 * order to use the font — family, license, subsets and the files with
 * weight/style/range.
 *
 * Nothing is copied into the project: the artboard, the motion composition and the
 * app window declare the same `@font-face` pointing here (the scheme sends CORS,
 * which is what a font on an opaque origin requires). It is the same design as
 * `orbit-design://`/`orbit-motion://`.
 */

export interface FontFileRef {
  /** File name in `files/` (content hash + extension). */
  file: string
  subset: string
  /** CSS weight: `400` on the static one, `100 900` on the variable one. */
  weight: string
  style: 'normal' | 'italic'
  /** `unicode-range` of the subset, when the package reports it. */
  unicodeRange?: string
}

export interface OrbitFont {
  /** Fontsource slug (e.g. `inter`, `jetbrains-mono`). */
  id: string
  family: string
  category?: string
  license?: { type: string; url?: string; attribution?: string }
  /** Variable: one file covers the whole weight range. */
  variable: boolean
  weights: string[]
  styles: string[]
  subsets: string[]
  files: FontFileRef[]
  addedAt: number
}

interface FontIndex {
  v: 1
  fonts: OrbitFont[]
}

const SAFE_FILE = /^[a-f0-9]{32}\.(?:woff2|woff|ttf|otf)$/
const MIME: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

export function fontsRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'fonts')
}

export function fontFilesDir(): string {
  return path.join(fontsRoot(), 'files')
}

function indexFile(): string {
  return path.join(fontsRoot(), 'index.json')
}

let cache: { mtimeMs: number; fonts: OrbitFont[] } | null = null

/** The index, reused while the file does not change on disk. */
export async function listFonts(): Promise<OrbitFont[]> {
  const stat = await fsp.stat(indexFile()).catch(() => null)
  if (!stat) {
    cache = null
    return []
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.fonts
  try {
    const parsed = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as FontIndex
    const fonts = Array.isArray(parsed?.fonts) ? parsed.fonts : []
    cache = { mtimeMs: stat.mtimeMs, fonts }
    return fonts
  } catch {
    return cache?.fonts ?? []
  }
}

async function writeIndex(fonts: OrbitFont[]): Promise<void> {
  await fsp.mkdir(fontsRoot(), { recursive: true })
  await writeFileAtomic(indexFile(), JSON.stringify({ v: 1, fonts } satisfies FontIndex, null, 2))
  cache = null
}

/** Finds by slug or by family (case-insensitive). */
export async function findFont(ref: string): Promise<OrbitFont | null> {
  const wanted = ref.trim().toLowerCase()
  if (!wanted) return null
  const fonts = await listFonts()
  return (
    fonts.find((font) => font.id.toLowerCase() === wanted) ??
    fonts.find((font) => font.family.toLowerCase() === wanted) ??
    null
  )
}

/** Writes the file into the store and returns the name (hash) — the same bytes do not enter twice. */
export async function storeFontFile(buffer: Buffer, ext: string): Promise<string> {
  const name = `${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)}.${ext}`
  await fsp.mkdir(fontFilesDir(), { recursive: true })
  const target = path.join(fontFilesDir(), name)
  const exists = await fsp
    .stat(target)
    .then((stat) => stat.isFile())
    .catch(() => false)
  if (!exists) await writeFileAtomic(target, buffer)
  return name
}

/** Inserts or updates a family in the index (the Fontsource id is the key). */
export async function addFont(font: OrbitFont): Promise<OrbitFont> {
  return withAssetLock('fonts:index', async () => {
    const fonts = await listFonts()
    const next = fonts.filter((item) => item.id !== font.id)
    const previous = fonts.find((item) => item.id === font.id)
    next.push({ ...font, addedAt: previous?.addedAt ?? font.addedAt })
    next.sort((a, b) => a.family.localeCompare(b.family))
    await writeIndex(next)
    return font
  })
}

export function fontUrl(file: string): string {
  return `${FONT_SCHEME}://f/${file}`
}

/**
 * Path of a library file from the NAME (`<hash>.<ext>`), with the name validated by
 * the same `SAFE_FILE` as the scheme handler — `null` for anything that does not have
 * the format we ourselves generate (`..` included).
 *
 * It exists for whoever serves the file WITHOUT going through the protocol: on the
 * phone `orbit-font://` does not resolve, so the companion's HTTP server looks the
 * path up here (see companion-assets.ts) and streams the bytes.
 */
export function resolveFontFile(name: string): string | null {
  return SAFE_FILE.test(name) ? path.join(fontFilesDir(), name) : null
}

/** The `@font-face` of each library file — a single declaration, used in every target. */
export function fontFaceCss(fonts: OrbitFont[]): string {
  const blocks: string[] = []
  for (const font of fonts) {
    const family = font.family.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    for (const ref of font.files) {
      const range = ref.unicodeRange ? `\n  unicode-range: ${ref.unicodeRange};` : ''
      blocks.push(
        `@font-face {\n  font-family: '${family}';\n  font-style: ${ref.style};\n  font-weight: ${ref.weight};\n  font-display: swap;\n  src: url('${fontUrl(ref.file)}') format('woff2');${range}\n}`,
      )
    }
  }
  return blocks.join('\n')
}

/** The CSS of all the fonts, built once per version of the index: `listFonts`
 *  returns the SAME array while the file does not change, so its identity is
 *  the key. It is called for every artboard served (see design-store.ts), not on
 *  every request. */
let facesCache: { fonts: OrbitFont[]; css: string } | null = null

/** All the fonts of the library, ready to inject into a document. */
export async function allFontFacesCss(): Promise<string> {
  const fonts = await listFonts()
  if (facesCache && facesCache.fonts === fonts) return facesCache.css
  const css = fontFaceCss(fonts)
  facesCache = { fonts, css }
  return css
}

/**
 * The `@font-face` of the requested family, when it comes from the library.
 *
 * Empty when the name is not installed here - then the font is from the system (or
 * made up) and there is nothing to declare: Chromium resolves it by name, as it
 * always did.
 */
export async function fontFacesForFamily(family: string): Promise<string> {
  const wanted = family.trim().toLowerCase()
  if (!wanted) return ''
  const fonts = await listFonts()
  const match = fonts.find((font) => font.family.trim().toLowerCase() === wanted)
  return match ? fontFaceCss([match]) : ''
}

// The scheme privileges live in registerSchemePrivileges (media.ts): Chromium
// only honors the LAST call to registerSchemesAsPrivileged, so the app has a
// single list — a second one here would wipe design, motion and audio.

export async function handleFontRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const headers = { 'Access-Control-Allow-Origin': '*' }
  if (!SAFE_FILE.test(name)) return new Response('not found', { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } })
  const file = path.join(fontFilesDir(), name)
  const size = await fsp
    .stat(file)
    .then((stat) => (stat.isFile() ? stat.size : null))
    .catch(() => null)
  if (size === null) return new Response('not found', { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } })
  const type = MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
  const stream = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream
  return new Response(size > 0 ? stream : new Uint8Array(0), {
    headers: {
      ...headers,
      'Content-Type': type,
      'Content-Length': String(size),
      // The name is the hash of the content: the file never changes.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}

export function registerFontProtocol(): void {
  protocol.handle(FONT_SCHEME, handleFontRequest)
}
