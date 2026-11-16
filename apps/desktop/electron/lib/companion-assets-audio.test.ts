import fsp from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createAssetToken } from './companion-token'
import { serveAsset } from './companion-assets'

/**
 * The audio plan the phone reads under a motion piece: the desktop's own resolution
 * (manifest, loose file), normalized, with no way for the phone to see anything outside the folder.
 */

const DIR = vi.hoisted(() => `/tmp/orbit-companion-audio-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => DIR, isPackaged: false },
  BrowserWindow: class {},
}))
vi.mock('./video/motion-store', () => ({
  getMotion: async (id: string) => (id === 'mv_a' ? { folder: DIR, entry: `${DIR}/index.html` } : null),
  resolveMotionFile: (folder: string, relative: string) => `${folder}/${relative}`,
}))

let server: Server
let base = ''

beforeAll(async () => {
  await fsp.rm(DIR, { recursive: true, force: true })
  await fsp.mkdir(DIR, { recursive: true })
  await fsp.writeFile(`${DIR}/index.html`, '<h1>m</h1>')
  await fsp.writeFile(`${DIR}/voz.mp3`, 'x')
  await fsp.writeFile(
    `${DIR}/audio.json`,
    JSON.stringify({ tracks: [{ file: 'voz.mp3', name: 'Voz', start: 2, gain: -6, fadeIn: 0.5 }] }),
  )
  server = createServer((req, res) => {
    const m = /^\/f\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(new URL(req.url ?? '/', 'http://x').pathname)
    if (!m) return void res.writeHead(400).end()
    void serveAsset(req, res, m[1], m[2], m[3], m[4] ?? '')
  })
  base = await new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)),
  )
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fsp.rm(DIR, { recursive: true, force: true })
})

describe('motion audio plan', () => {
  it('lists the manifest tracks with relative paths and the normalized numbers', async () => {
    const res = await fetch(`${base}/f/motion/mv_a/${createAssetToken('motion', 'mv_a')}/__orbit-audio.json`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tracks).toHaveLength(1)
    expect(body.tracks[0]).toMatchObject({ name: 'Voz', path: 'voz.mp3', start: 2, gainDb: -6, fadeIn: 0.5, loop: false })
  })

  it('is empty when the folder has no audio', async () => {
    await fsp.rm(`${DIR}/audio.json`)
    await fsp.rm(`${DIR}/voz.mp3`)
    const res = await fetch(`${base}/f/motion/mv_a/${createAssetToken('motion', 'mv_a')}/__orbit-audio.json`)
    expect((await res.json()).tracks).toEqual([])
  })
})

describe('motion page address', () => {
  it('sends the bare address to the entry, so relative files keep the token', async () => {
    const res = await fetch(`${base}/f/motion/mv_a/${createAssetToken('motion', 'mv_a')}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/\/index\.html$/)
  })

  it('serves the page with the runtime under the signed path', async () => {
    const token = createAssetToken('motion', 'mv_a')
    const html = await (await fetch(`${base}/f/motion/mv_a/${token}/index.html`)).text()
    expect(html).toContain(`/api/file/motion/mv_a/${token}/__orbit-runtime.js`)
    const runtime = await fetch(`${base}/f/motion/mv_a/${token}/__orbit-runtime.js`)
    expect(runtime.status).toBe(200)
    expect(runtime.headers.get('content-type')).toContain('javascript')
  })
})
