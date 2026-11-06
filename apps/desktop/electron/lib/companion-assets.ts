/**
 * Files served to the mobile app over HTTP.
 *
 * The phone has no Electron protocols, so everything it needs
 * to see (image, audio, video, artifact, document, motion/design/slides piece
 * and the font from the library) comes out through a single route:
 *
 *     /api/file/<scope>/<id>/<token>/<relative-path>
 *
 * The token goes in a SEGMENT of the path, and not in the query, because a piece
 * references its dependencies by relative path (`base.css`, `clip.mp4`,
 * `Pricing.html`). Resolved against the document, the relative one inherits the
 * token's directory — that is what makes `/api/file/design/dsg_x/<token>/base.css` work
 * without rewriting anything inside the piece.
 *
 * The `/api/media/<id>?t=` alias still holds for images: it is already
 * delivered and working on the phone, and there is no reason to touch what has not broken.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { readArtifactAsset, readMedia } from './media'
import { resolveAudioFile } from './audio-store'
import { videoFilePath } from './video/store'
import { getMotion, resolveMotionFile } from './video/motion-store'
import { getDesign, resolveDesignFile } from './design/design-store'
import { getSlides, resolveSlidesFile } from './slides/slides-store'
import { resolveFontFile } from './fonts/store'
import { isAssetScope, createAssetToken, validateAssetToken, type AssetScope } from './companion-token'
import { FONT_SCHEME } from '@shared/media'

/**
 * Types by extension for the files that pass through here. It covers what shows up
 * inside a piece (html/css/js/fonts/media) and what the players ask for.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'video/webm',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
}

function contentTypeOf(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * No cache by default. Every file here can be REWRITTEN in place keeping
 * the same id — `update_artifact` rewrites the page, `motion_edit` rewrites the
 * composition, `image_edit` may overwrite the image. Caching would serve the
 * old revision, and the symptom would be "I edited it and it did not change on the phone".
 */
const CACHE_REWRITABLE = 'no-store'

/** The requested file, already resolved to a buffer (small ones) or a path. */
interface ResolvedAsset {
  buffer?: Buffer
  file?: string
  contentType: string
  cache: string
}

/** Relative path of a piece's entry (motion/slides), with `/`. */
function entryRelative(folder: string, entry: string): string {
  return path.relative(folder, entry).split(path.sep).join('/')
}

/** `text/html` and `text/css` — the two types that can cite a font. */
function isTextualAsset(contentType: string): boolean {
  return /^text\/(?:html|css)/.test(contentType)
}

/**
 * The font URLs that the `<style>` of `font_use` (and design's `fontFacesForFamily`)
 * write into the document: `orbit-font://f/<file>`.
 *
 * `FONT_SCHEME` has no metacharacter, so it needs no escape in the regex.
 */
const FONT_URL_RE = new RegExp(`${FONT_SCHEME}://f/([A-Za-z0-9._-]+)`, 'g')

/**
 * Swaps `orbit-font://f/<file>` for the signed HTTP URL.
 *
 * The font scheme only exists INSIDE Electron: in an artifact loaded by the
 * phone's WebView it does not resolve and the font falls back to the system one, in
 * silence — the symptom is "on the phone the layout uses another font". Since the font
 * file has a validated name (`<hash>.<ext>`, the same as the store's), the token comes out
 * per file and in the `font` scope.
 *
 * This counts ONLY in the companion's HTTP path: the protocol's handler
 * (handleFontRequest, and the HTML the desktop loads) keeps seeing the original
 * URL — the `orbit-font://` has to keep working in the window.
 */
function rewriteFontUrls(text: string, base: string): string {
  if (!text.includes(`${FONT_SCHEME}://f/`)) return text
  return text.replace(FONT_URL_RE, (whole, file: string) => {
    if (!resolveFontFile(file)) return whole
    return `${base}/api/file/font/${file}/${createAssetToken('font', file)}`
  })
}

/** Response from a buffer, rewriting the fonts when it is textual. */
function bufferAsset(
  buffer: Buffer,
  contentType: string,
  base: string | null,
  cache: string = CACHE_REWRITABLE,
): ResolvedAsset {
  return {
    buffer: base && isTextualAsset(contentType)
      ? Buffer.from(rewriteFontUrls(buffer.toString('utf8'), base), 'utf8')
      : buffer,
    contentType,
    cache,
  }
}

/**
 * A file from disk, with the same font rewriting when it is HTML/CSS.
 *
 * Text comes out of the BUFFER (it is small and Range is useless on it); the rest
 * keeps coming out through the path and is streamed with Range by serveAsset.
 */
async function fileAsset(file: string, base: string | null): Promise<ResolvedAsset | null> {
  const contentType = contentTypeOf(file)
  if (!base || !isTextualAsset(contentType)) {
    return { file, contentType, cache: CACHE_REWRITABLE }
  }
  const raw = await fsp.readFile(file).catch(() => null)
  if (!raw) return null
  return bufferAsset(raw, contentType, base)
}

/**
 * Translates (scope, id, relative) into the file that exists on disk. `null` = it does not
 * exist, invalid id or a path that escapes the piece's root — whoever calls
 * answers 404 without distinguishing the cases, so as not to become a disk probe.
 *
 * The `relative` arrives PERCENT-ENCODED and what decodes it is each store's
 * `resolve*File` (the same contract as the scheme handlers). Decoding here
 * would decode twice.
 */
async function resolveAsset(
  scope: AssetScope,
  id: string,
  relative: string,
  /** `http://host:port` as the phone sees the desktop — the base of the font URLs
   *  rewritten inside the HTML/CSS. `null` keeps `orbit-font://` (a desktop peer,
   *  whose own main serves it). */
  base: string | null,
): Promise<ResolvedAsset | null> {
  switch (scope) {
    case 'media': {
      const media = await readMedia(id)
      if (!media) return null
      return {
        buffer: media.buffer,
        contentType: media.contentType,
        cache: 'private, max-age=86400',
      }
    }

    case 'artifact': {
      const asset = await readArtifactAsset(id)
      if (!asset) return null
      return bufferAsset(asset.buffer, asset.contentType, base)
    }

    case 'audio': {
      const file = resolveAudioFile(id)
      if (!file) return null
      return { file, contentType: contentTypeOf(file), cache: CACHE_REWRITABLE }
    }

    case 'video': {
      const file = await videoFilePath(id)
      if (!file) return null
      return { file, contentType: contentTypeOf(file), cache: CACHE_REWRITABLE }
    }

    case 'motion': {
      const entry = await getMotion(id)
      if (!entry) return null
      const file = resolveMotionFile(entry.folder, relative || entryRelative(entry.folder, entry.entry))
      if (!file) return null
      return fileAsset(file, base)
    }

    case 'design': {
      const entry = await getDesign(id)
      if (!entry) return null
      const file = resolveDesignFile(entry.folder, relative || 'canvas.json')
      if (!file) return null
      return fileAsset(file, base)
    }

    case 'slides': {
      const entry = await getSlides(id)
      if (!entry) return null
      const file = resolveSlidesFile(entry.folder, relative || entryRelative(entry.folder, entry.entry))
      if (!file) return null
      return fileAsset(file, base)
    }

    case 'font': {
      const file = resolveFontFile(id)
      if (!file) return null
      // The name is the hash of the content: the same byte is never rewritten under another
      // name, so here the immutable cache is safe (unlike the rest).
      return {
        file,
        contentType: contentTypeOf(file),
        cache: 'public, max-age=31536000, immutable',
      }
    }
  }
}

/** The `Range` as `<video>`/`<audio>` ask for it: start and end in bytes. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!match) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return { start, end }
}

/**
 * Serves a desktop file to the phone.
 *
 * Range is mandatory here: without it the video does not play and the audio does not seek
 * position — the players ask for the size and request chunks, and the WebView's `<video>`
 * does too. The header decides, and the answer is 206 when it comes.
 */
export async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  scope: string,
  id: string,
  token: string,
  relative: string,
  options: { rewriteFonts?: boolean } = {},
): Promise<void> {
  const headers = (extra: Record<string, string>) => ({
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    ...extra,
  })

  if (!isAssetScope(scope) || !validateAssetToken(scope, id, token)) {
    res.writeHead(401, headers({ 'Content-Type': 'application/json' }))
    res.end(JSON.stringify({ error: 'Invalid or expired token' }))
    return
  }

  const base = options.rewriteFonts === false ? null : `http://${req.headers.host ?? 'localhost'}`
  const asset = await resolveAsset(scope, id, relative, base)
  if (!asset) {
    res.writeHead(404, headers({ 'Content-Type': 'text/plain; charset=utf-8' }))
    res.end('not found')
    return
  }

  const head = req.method === 'HEAD'

  if (asset.buffer) {
    res.writeHead(200, headers({
      'Content-Type': asset.contentType,
      'Content-Length': String(asset.buffer.length),
      'Cache-Control': asset.cache,
    }))
    res.end(head ? undefined : asset.buffer)
    return
  }

  const file = asset.file as string
  let size: number
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch {
    res.writeHead(404, headers({ 'Content-Type': 'text/plain; charset=utf-8' }))
    res.end('not found')
    return
  }

  const range = parseRange(req.headers.range, size)
  if (range && (range.start >= size || range.start > range.end)) {
    res.writeHead(416, headers({ 'Content-Range': `bytes */${size}` }))
    res.end()
    return
  }

  const start = range?.start ?? 0
  const end = range?.end ?? Math.max(0, size - 1)
  const length = size === 0 ? 0 : end - start + 1

  res.writeHead(range ? 206 : 200, headers({
    'Content-Type': asset.contentType,
    'Content-Length': String(length),
    'Cache-Control': asset.cache,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  }))

  if (head || size === 0) {
    res.end()
    return
  }

  const stream = fs.createReadStream(file, { start, end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
