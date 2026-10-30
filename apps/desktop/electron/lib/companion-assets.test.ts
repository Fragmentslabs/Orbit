import fsp from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createAssetToken } from './companion-token'
import { serveAsset } from './companion-assets'

/**
 * The route the phone uses for EVERYTHING that is not JSON: audio, video, artifact,
 * document and the motion/design/slides pieces.
 *
 * Two contracts here are worth testing because they break silently: the token counts only for
 * the scope+id pair (otherwise an audio token would open an artifact), and the Range
 * answers 206 with the right bytes (without it the player neither plays nor seeks
 * position).
 */

const USER_DATA = vi.hoisted(() => `/tmp/orbit-companion-assets-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, isPackaged: false },
  BrowserWindow: class {},
}))

const ORBIT_DATA = `${USER_DATA}/orbit-data`

/** Font file name in the store: 32-hex hash + extension. */
const FONT_FILE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90.woff2'

/** Artifact HTML as `font_use` leaves it: the @font-face points to the scheme. */
const ARTIFACT_WITH_FONT = `<!doctype html><style>
@font-face { font-family: 'Inter'; src: url('orbit-font://f/${FONT_FILE}') format('woff2'); }
body { font-family: 'Inter', sans-serif; }
</style><h1>with font</h1>`

let server: Server
let base = ''

/** Brings up a minimal server in front of serveAsset: it exercises the real
 *  route (status, headers, body) instead of a fake request object. */
function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      // It accepts `/f/...` (the test's shortcut) and `/api/file/...` (the real path, which
      // the rewritten font URL uses) — what serves is the same serveAsset.
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const match = /^\/(?:f|api\/file)\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(pathname)
      if (!match) {
        res.writeHead(400).end()
        return
      }
      void serveAsset(req, res, match[1], decodeURIComponent(match[2]), match[3], match[4] ?? '')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

beforeAll(async () => {
  await fsp.rm(USER_DATA, { recursive: true, force: true })
  await fsp.mkdir(`${ORBIT_DATA}/media`, { recursive: true })
  await fsp.mkdir(`${ORBIT_DATA}/artifacts`, { recursive: true })
  await fsp.mkdir(`${ORBIT_DATA}/audio`, { recursive: true })
  await fsp.mkdir(`${ORBIT_DATA}/fonts/files`, { recursive: true })

  // A real 1x1 PNG — the test is of the transport, not of the image.
  await fsp.writeFile(
    `${ORBIT_DATA}/media/img_a.png`,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  await fsp.writeFile(`${ORBIT_DATA}/artifacts/art_a.html`, '<!doctype html><h1>hi</h1>')
  await fsp.writeFile(`${ORBIT_DATA}/artifacts/art_font.html`, ARTIFACT_WITH_FONT)
  // 10 bytes with known values, to check the Range slice.
  await fsp.writeFile(`${ORBIT_DATA}/audio/aud_z1.wav`, Buffer.from('0123456789'))
  // A fake font: the test is of the transport (MIME, token, URL), not of the glyph.
  await fsp.writeFile(`${ORBIT_DATA}/fonts/files/${FONT_FILE}`, Buffer.from('wOF2fake-font-bytes'))

  base = await startServer()
})

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await fsp.rm(USER_DATA, { recursive: true, force: true })
})

/** GET on the route, with the scope+id pair's token when the test does not pass another. */
function get(scope: string, id: string, opts: { token?: string; relative?: string; method?: string; range?: string } = {}) {
  const token = opts.token ?? createAssetToken(scope as never, id)
  const relative = opts.relative ? `/${opts.relative}` : ''
  return fetch(`${base}/f/${scope}/${encodeURIComponent(id)}/${token}${relative}`, {
    method: opts.method ?? 'GET',
    headers: opts.range ? { Range: opts.range } : undefined,
  })
}

describe('token', () => {
  it('serves the file of the scope with the right token', async () => {
    const res = await get('artifact', 'art_a.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<h1>hi</h1>')
  })

  it('refuses the token of a scope used in another', async () => {
    // The audio token does not open the artifact — it is what prevents a URL issued
    // for one file from serving as a key for the whole folder.
    const res = await fetch(
      `${base}/f/artifact/art_a.html/${createAssetToken('audio', 'aud_z1.wav')}`,
    )
    expect(res.status).toBe(401)
  })

  it('rejects an expired or malformed token', async () => {
    // `exp` in the past: the signature is not even checked.
    expect((await fetch(`${base}/f/artifact/art_a.html/1.deadbeef`)).status).toBe(401)
    expect((await fetch(`${base}/f/artifact/art_a.html/abacaxi`)).status).toBe(401)
  })

  it('a URL without the token segment does not even reach serveAsset', async () => {
    // The server route requires scope/id/token: without the token the request falls into the
    // global auth block (Bearer 401), never into an undefended file.
    const res = await fetch(`${base}/f/artifact/art_a.html/`)
    expect(res.status).toBe(400)
  })

  it('an unknown scope serves nothing', async () => {
    const res = await fetch(`${base}/f/secret/art_a.html/${createAssetToken('artifact', 'art_a.html')}`)
    expect(res.status).toBe(401)
  })
})

describe('files', () => {
  it('serves the image already on disk (same route as the parts)', async () => {
    const res = await get('media', 'img_a.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('404 when the id does not exist or is not in the format we generate', async () => {
    expect((await get('artifact', 'art_missing.html')).status).toBe(404)
    // Outside SAFE_ARTIFACT_ID: it does not become a disk read.
    expect((await get('artifact', '../media-secret')).status).toBe(404)
  })

  it('404 for a piece that is not registered', async () => {
    expect((await get('motion', 'mv_missing')).status).toBe(404)
    expect((await get('design', 'dsg_missing')).status).toBe(404)
    expect((await get('slides', 'sld_missing')).status).toBe(404)
  })
})

describe('font', () => {
  it('serves the library file with the right content-type', async () => {
    // On the phone orbit-font:// does not exist: the font has to come out through here, with
    // the MIME the font engine accepts (fonts/woff2, not octet-stream).
    const res = await get('font', FONT_FILE)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('font/woff2')
    // Name = hash of the content: the byte never changes, so the cache can be forever.
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe('wOF2fake-font-bytes')
  })

  it('refuses the token of another scope and a name that is not from the store', async () => {
    // An artifact token does not open a font — the same rule as the other scopes.
    const crossScope = await fetch(
      `${base}/f/font/${FONT_FILE}/${createAssetToken('artifact', 'art_a.html')}`,
    )
    expect(crossScope.status).toBe(401)
    // Outside SAFE_FILE: no reading outside fonts/files.
    expect((await get('font', '../media-secret')).status).toBe(404)
    expect((await get('font', 'missing.woff2')).status).toBe(404)
  })

  it('rewrites the orbit-font:// of the served HTML into the HTTP URL with token', async () => {
    const res = await get('artifact', 'art_font.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    // No Electron scheme is left in the document the phone receives: with
    // it the font would fall back to the system one, silently.
    expect(html).not.toContain('orbit-font://')
    expect(html).toContain(`/api/file/font/${FONT_FILE}/`)
    expect(html).toContain("format('woff2')")

    // The rewritten URL is real: requesting it, the font comes out.
    const url = /src: url\('([^']+)'\)/.exec(html)?.[1] ?? ''
    const font = await fetch(url)
    expect(font.status).toBe(200)
    expect(font.headers.get('content-type')).toBe('font/woff2')
  })

  it('does not touch HTML that does not reference a font', async () => {
    const html = await (await get('artifact', 'art_a.html')).text()
    expect(html).not.toContain('/api/file/font/')
    expect(html).toContain('<h1>hi</h1>')
  })
})

describe('Range', () => {
  it('answers 206 with the requested chunk — that is what makes the player play', async () => {
    const res = await get('audio', 'aud_z1.wav', { range: 'bytes=2-5' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(res.headers.get('content-length')).toBe('4')
    expect(await res.text()).toBe('2345')
  })

  it('without Range, delivers the whole file', async () => {
    const res = await get('audio', 'aud_z1.wav')
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(await res.text()).toBe('0123456789')
  })

  it('416 when the Range starts after the end', async () => {
    const res = await get('audio', 'aud_z1.wav', { range: 'bytes=99-120' })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
  })

  it('HEAD answers headers without a body', async () => {
    const res = await get('audio', 'aud_z1.wav', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('10')
    expect(await res.text()).toBe('')
  })
})
