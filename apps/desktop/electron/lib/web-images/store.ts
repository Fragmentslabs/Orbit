import { app, net, protocol, session } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { WEB_IMAGE_SCHEME } from '@shared/media'
import { isSafeImageUrl } from '../image-search/download'
import type { WebImageCandidate } from './candidates'

/**
 * Web images shown in the chat. The user sees them; they do not become gallery media.
 *
 * Fetching goes through the MAIN process, with the page's address as Referer and the
 * hidden browser's own session (so a site where the user logged in serves what it
 * serves them): hotlink protection refuses a bare <img> in the renderer, and an <img>
 * pointing straight at a third party would tell that third party who is reading. What
 * comes back is shrunk to a WebP and kept in a cache folder, served by orbit-web://,
 * so the conversation still shows it after a restart. It is a cache — it is not the
 * gallery, and it is cleaned.
 */

export const WEB_PARTITION = 'persist:orbit-web'
const MAX_BYTES = 15 * 1024 * 1024
const TIMEOUT_MS = 20_000
const MAX_SIDE = 1600
const KEEP_DAYS = 45
const FILE = /^[a-f0-9]{10}\.webp$/
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

export function webSession() {
  return session.fromPartition(WEB_PARTITION)
}

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'web-cache')
}

async function readCapped(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) throw new Error('image is too large')
  const reader = res.body?.getReader()
  if (!reader) throw new Error('empty response')
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw new Error('image is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function fetchImage(url: string, referer: string | undefined): Promise<Buffer> {
  if (!isSafeImageUrl(url)) throw new Error('unsafe or non-https image address')
  const ses = webSession()
  const attempt = async (withReferer: boolean) => {
    const res = await ses.fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.5', ...(withReferer && referer ? { Referer: referer } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`the server answered ${res.status}`)
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'unknown type'})`)
    return readCapped(res)
  }
  try {
    return await attempt(true)
  } catch (first) {
    // Some servers refuse a Referer that is not theirs; the bare request is the second try.
    try {
      return await attempt(false)
    } catch {
      throw first
    }
  }
}

export interface CachedWebImage {
  /** orbit-web://<hash>.webp */
  src: string
  width: number
  height: number
}

/** Downloads the candidate (or its alternative address), shrinks it and caches it. */
export async function cacheWebImage(candidate: WebImageCandidate): Promise<CachedWebImage> {
  const name = `${createHash('sha1').update(candidate.imageUrl).digest('hex').slice(0, 10)}.webp`
  const target = path.join(cacheDir(), name)
  try {
    const meta = await sharp(target).metadata()
    if (meta.width && meta.height) return { src: `${WEB_IMAGE_SCHEME}://${name}`, width: meta.width, height: meta.height }
  } catch {
    // not cached yet
  }
  let raw: Buffer
  try {
    raw = await fetchImage(candidate.imageUrl, candidate.pageUrl)
  } catch (first) {
    if (!candidate.fallbackUrl) throw first
    raw = await fetchImage(candidate.fallbackUrl, undefined).catch(() => {
      throw first
    })
  }
  const out = await sharp(raw)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84 })
    .toBuffer({ resolveWithObject: true })
  await fsp.mkdir(cacheDir(), { recursive: true })
  await fsp.writeFile(target, out.data)
  return { src: `${WEB_IMAGE_SCHEME}://${name}`, width: out.info.width, height: out.info.height }
}

/** Bytes of a cached image (copy / save from the lightbox). */
export async function readWebImage(ref: string): Promise<{ buffer: Buffer; contentType: string; ext: string } | null> {
  const name = ref.startsWith(`${WEB_IMAGE_SCHEME}://`) ? ref.slice(`${WEB_IMAGE_SCHEME}://`.length).replace(/\/+$/, '') : ''
  if (!FILE.test(name)) return null
  try {
    return { buffer: await fsp.readFile(path.join(cacheDir(), name)), contentType: 'image/webp', ext: 'webp' }
  } catch {
    return null
  }
}

async function sweepOld(): Promise<void> {
  try {
    const dir = cacheDir()
    const limit = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const name of await fsp.readdir(dir)) {
      const file = path.join(dir, name)
      const stat = await fsp.stat(file)
      if (stat.mtimeMs < limit) await fsp.unlink(file)
    }
  } catch {
    // no folder yet, or a file that vanished: nothing to clean
  }
}

/** Registers orbit-web:// (call after app.whenReady). */
export function registerWebImageProtocol(): void {
  protocol.handle(WEB_IMAGE_SCHEME, (request) => {
    const name = request.url.slice(`${WEB_IMAGE_SCHEME}://`.length).replace(/\/+$/, '')
    if (!FILE.test(name)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(path.join(cacheDir(), name)).toString())
  })
  void sweepOld()
}
