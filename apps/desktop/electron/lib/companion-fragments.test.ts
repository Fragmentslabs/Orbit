import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const tmp = path.join(os.tmpdir(), `orbit-companion-fragments-${process.pid}`)
const covers = vi.hoisted(() => ({ png: Buffer.alloc(0), windows: 0, urls: [] as string[] }))

vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  // Enough of a window for the cover: the page "settles" at once and the picture is a tiny PNG.
  BrowserWindow: Object.assign(
    class {
      webContents = {
        getTitle: () => 'orbit-cover-ready',
        capturePage: async () => ({ toPNG: () => covers.png }),
      }
      constructor() {
        covers.windows += 1
      }
      loadURL = async (url: string) => {
        covers.urls.push(url)
      }
      isDestroyed = () => false
      destroy = () => {}
    },
    { getAllWindows: () => [] },
  ),
  protocol: { handle: vi.fn() },
  Notification: class {},
}))

const store = await import('./fragments/fragment-store')
const { createAssetToken } = await import('./companion-token')
const { serveAsset } = await import('./companion-assets')
const { FRAGMENT_HOST_FILE, fragmentHostHtml } = await import('./fragments/fragment-phone')

/** A response we can read: serveAsset writes to a ServerResponse, and streams a file into it. */
function fakeResponse() {
  const out = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) }
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(chunk))
  const finished = new Promise<void>((resolve) => {
    stream.on('end', () => {
      out.body = Buffer.concat(chunks)
      resolve()
    })
  })
  const res = Object.assign(stream, {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status
      out.headers = headers
    },
  })
  return { out, res: res as never, finished }
}

async function get(scope: string, id: string, token: string, relative: string) {
  const { out, res, finished } = fakeResponse()
  await serveAsset({ method: 'GET', headers: { host: '192.168.0.2:3848' }, url: `/x/${relative}` } as never, res, scope, id, token, relative)
  await finished
  return out
}

beforeAll(async () => {
  await fsp.mkdir(tmp, { recursive: true })
  const sharp = (await import('sharp')).default
  covers.png = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#888888' } }).png().toBuffer()
})
afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

describe('a fragment served to the phone', () => {
  it('answers the bare address with the host page, under the closed policy', async () => {
    const m = await store.createFragment({ name: 'Gastos', html: '<html><head></head><body><p>oi</p></body></html>' })
    const token = createAssetToken('fragment', m.id)
    const bare = await get('fragment', m.id, token, '')
    expect(bare.status).toBe(302)
    const host = await get('fragment', m.id, token, FRAGMENT_HOST_FILE)
    expect(host.status).toBe(200)
    expect(host.body.toString()).toContain('ReactNativeWebView')
    expect(host.body.toString()).toContain('index.html?__t=')
    expect(host.headers['Content-Security-Policy']).toContain("frame-src 'self'")
  })

  it('serves the page with the SDK, the tokens and no network, and other files as they are', async () => {
    const m = await store.createFragment({ name: 'Files', html: '<html><head></head><body>x</body></html>' })
    await store.writeFragmentFile(m.id, 'style.css', 'p{color:red}')
    const token = createAssetToken('fragment', m.id)
    const page = await get('fragment', m.id, token, 'index.html')
    const html = page.body.toString()
    expect(html).toContain('window.orbit')
    expect(html).toContain('orbit-tokens')
    expect(page.headers['Content-Security-Policy']).toContain("connect-src 'self'")
    const css = await get('fragment', m.id, token, 'style.css')
    expect(css.body.toString()).toBe('p{color:red}')
    expect(css.headers['Content-Type']).toContain('text/css')
  })

  it('refuses a token of another fragment, a path that climbs out and a missing file', async () => {
    const a = await store.createFragment({ name: 'A', html: '<p>a</p>' })
    const b = await store.createFragment({ name: 'B', html: '<p>b</p>' })
    expect((await get('fragment', a.id, createAssetToken('fragment', b.id), 'index.html')).status).toBe(401)
    const token = createAssetToken('fragment', a.id)
    expect((await get('fragment', a.id, token, '..%2Fmanifest.json')).status).toBe(404)
    expect((await get('fragment', a.id, token, 'nope.html')).status).toBe(404)
  })
})

describe('the host page', () => {
  it('forwards only what carries the load token and answers through the app', () => {
    const html = fragmentHostHtml()
    expect(html).toContain('d.t !== token')
    expect(html).toContain('window.__orbitReply')
    expect(html).toContain('window.__orbitTheme')
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"')
  })
})

describe('permissions granted from the phone', () => {
  it('grants and revokes what the fragment asked for, and nothing it did not', async () => {
    const { grantFragmentCapability } = await import('./fragments/fragment-grant')
    const m = await store.createFragment({ name: 'Perm', html: '<p>x</p>', requests: ['ai', 'notify'] })
    expect((await grantFragmentCapability(m.id, 'ai', true))?.grants).toEqual(['ai'])
    // A capability it never asked for is not granted by being clicked.
    expect((await grantFragmentCapability(m.id, 'http', true))?.grants).toEqual(['ai'])
    expect((await grantFragmentCapability(m.id, 'ai', false))?.grants).toEqual([])
    // An unknown capability or id does nothing.
    expect(await grantFragmentCapability(m.id, 'root', true)).toBeNull()
    expect(await grantFragmentCapability('frag-nope-000000', 'ai', true)).toBeNull()
  })

  it('tells the other views, so the desktop tab and the phones read the manifest again', async () => {
    const { grantFragmentCapability } = await import('./fragments/fragment-grant')
    const m = await store.createFragment({ name: 'Heard', html: '<p>x</p>', requests: ['ai'] })
    const seen: string[] = []
    store.fragmentEvents.on('updated', (e: { fragmentId: string }) => seen.push(e.fragmentId))
    await grantFragmentCapability(m.id, 'ai', true)
    expect(seen).toContain(m.id)
  })
})

describe('deleting a fragment from the phone', () => {
  it('removes it, says so to every view and answers false for one that is gone', async () => {
    const { deleteFragment } = await import('./fragments/fragment-delete')
    const m = await store.createFragment({ name: 'Doomed', html: '<p>x</p>' })
    const seen: string[] = []
    store.fragmentEvents.on('removed', (e: { fragmentId: string }) => seen.push(e.fragmentId))
    expect(await deleteFragment(m.id)).toBe(true)
    expect(await store.getFragment(m.id)).toBeNull()
    expect(seen).toContain(m.id)
    expect(await deleteFragment(m.id)).toBe(false)
    expect(await deleteFragment('not an id')).toBe(false)
  })
})

describe('the read the host page makes while a cover is taken', () => {
  it('answers store.get from the fragment and refuses everything else', async () => {
    const m = await store.createFragment({ name: 'Reads', html: '<p>x</p>' })
    await store.storeSet(m.id, 'total', 42)
    const token = createAssetToken('fragment', m.id)
    const ask = async (method: string, params: unknown) => {
      const { out, res, finished } = fakeResponse()
      await serveAsset(
        { method: 'GET', headers: { host: 'h:1' }, url: `/x/__orbit-call?m=${encodeURIComponent(method)}&p=${encodeURIComponent(JSON.stringify(params))}` } as never,
        res,
        'fragment',
        m.id,
        token,
        '__orbit-call',
      )
      await finished
      return JSON.parse(out.body.toString())
    }
    expect(await ask('store.get', { key: 'total' })).toEqual({ ok: true, value: 42 })
    expect(await ask('store.keys', {})).toEqual({ ok: true, value: ['total'] })
    expect((await ask('store.set', { key: 'total', value: 0 })).error.code).toBe('preview')
    expect((await ask('ai.generate', { prompt: 'x' })).error.code).toBe('preview')
    expect(await store.storeGet(m.id, 'total')).toBe(42)
  })
})

describe('the cover of a fragment for the phone list', () => {
  it('takes the picture once per revision and theme, and takes a new one when the page changes', async () => {
    const m = await store.createFragment({ name: 'Cover', html: '<p>x</p>' })
    const token = createAssetToken('fragment', m.id)
    const before = covers.windows
    const first = await get('fragment', m.id, token, '__orbit-cover-dark.png')
    expect(first.status).toBe(200)
    expect(first.headers['Content-Type']).toBe('image/png')
    expect(first.body.subarray(1, 4).toString()).toBe('PNG')
    expect(covers.urls.at(-1)).toContain('/api/file/fragment/')
    expect(covers.urls.at(-1)).toContain('cover=1&theme=dark')
    await get('fragment', m.id, token, '__orbit-cover-dark.png')
    expect(covers.windows).toBe(before + 1)
    await get('fragment', m.id, token, '__orbit-cover-light.png')
    expect(covers.windows).toBe(before + 2)

    await store.writeFragmentFile(m.id, 'index.html', '<p>changed</p>')
    await get('fragment', m.id, token, '__orbit-cover-dark.png')
    expect(covers.windows).toBe(before + 3)
  })

  it('has no cover to give for a fragment that is gone', async () => {
    const m = await store.createFragment({ name: 'Gone', html: '<p>x</p>' })
    const token = createAssetToken('fragment', m.id)
    await store.removeFragment(m.id)
    expect((await get('fragment', m.id, token, '__orbit-cover-dark.png')).status).toBe(404)
  })
})
