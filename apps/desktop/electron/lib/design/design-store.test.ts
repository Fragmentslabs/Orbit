import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** Mirrors motion-store.test.ts: `protocol.handle` is mocked, but it keeps track of who
 *  arrived — this is how the test calls the scheme for real. `windows` are the
 *  windows that receive design:changed (the watcher test puts one in and reads the
 *  payload the Design tab uses to reload only the artboard that changed). */
const registered = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }>,
}))

// The module touches `app`/`protocol`/`BrowserWindow` (it belongs to main). The index
// lands in a temporary folder and no real protocol is registered.
vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-design-store-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => registered.windows },
    protocol: {
      handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
        registered.handlers.set(scheme, handler)
      },
    },
  }
})

const {
  designIdFor,
  designIdForName,
  designIdForPath,
  getDesign,
  readDesignBoard,
  registerDesign,
  registerDesignProtocol,
  resolveDesignFile,
  unregisterDesign,
  updateDesignBoard,
  writeDesignBoard,
} = await import('./design-store')
const { DESIGN_RUNTIME_PATH, injectDesignRuntime } = await import('./design-runtime')

const tempRoot = path.join(os.tmpdir(), `orbit-design-store-test-${process.pid}`)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('resolveDesignFile', () => {
  const folder = path.join('C:', 'orbit-data', 'design', 'sess1', 'landing')

  it('resolves a file inside the canvas folder', () => {
    expect(resolveDesignFile(folder, '/canvas.json')).toBe(path.resolve(folder, 'canvas.json'))
    expect(resolveDesignFile(folder, '/Main.html')).toBe(path.resolve(folder, 'Main.html'))
    expect(resolveDesignFile(folder, '/assets/logo%20final.svg')).toBe(path.resolve(folder, 'assets', 'logo final.svg'))
  })

  it('rejects `..` in any position, even percent-encoded', () => {
    expect(resolveDesignFile(folder, '../secret.html')).toBeNull()
    expect(resolveDesignFile(folder, '/../secret.html')).toBeNull()
    expect(resolveDesignFile(folder, '/..%2F..%2Fsecret.html')).toBeNull()
  })

  it('rejects an absolute OS path and junk', () => {
    expect(resolveDesignFile(folder, 'C:/Windows/System32/evil.html')).toBeNull()
    expect(resolveDesignFile(folder, '')).toBeNull()
    expect(resolveDesignFile(folder, '/')).toBeNull()
    expect(resolveDesignFile(folder, '/a%00b.html')).toBeNull()
  })
})

describe('designIdFor', () => {
  it('is deterministic and stable for the same folder', () => {
    const a = designIdFor('C:/proj/design/landing')
    const b = designIdFor('C:/proj/design/landing')
    expect(a).toBe(b)
    expect(a).toMatch(/^dsg_[a-z0-9]+$/)
  })

  it('differs for different folders', () => {
    expect(designIdFor('C:/proj/design/a')).not.toBe(designIdFor('C:/proj/design/b'))
  })
})

describe('registerDesign / getDesign / designIdForName / unregisterDesign', () => {
  it('registers, finds by name in the session and undoes', async () => {
    const folder = path.join(tempRoot, 'sess1', 'landing-page')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'canvas.json'), '{"v":1,"boards":{},"order":[]}', 'utf8')

    const { id, created } = await registerDesign(folder, { sessionId: 'sess1' })
    expect(created).toBe(true)
    expect(id).toBe(designIdFor(folder))

    const entry = await getDesign(id)
    expect(entry?.folder).toBe(path.resolve(folder))
    expect(entry?.sessionId).toBe('sess1')

    const foundId = await designIdForName('sess1', 'landing-page')
    expect(foundId).toBe(id)
    // Another session does not find the same canvas.
    expect(await designIdForName('sess2', 'landing-page')).toBeNull()

    // Registering again is idempotent: same id.
    const again = await registerDesign(folder, { sessionId: 'sess1' })
    expect(again.id).toBe(id)
    expect(again.created).toBe(false)

    await unregisterDesign(id)
    expect(await getDesign(id)).toBeUndefined()
  })
})

describe('designIdForPath', () => {
  it('finds by the exact path, and by the end of the path when the exact one does not resolve', async () => {
    const folder = path.join(tempRoot, 'proj', 'design', 'logo')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'canvas.json'), '{"v":1,"boards":{},"order":[]}', 'utf8')
    const { id } = await registerDesign(folder, { root: path.join(tempRoot, 'proj') })

    expect(await designIdForPath(folder)).toBe(id)
    // Relative path that does not resolve against the app cwd: falls to the end of the path.
    expect(await designIdForPath('design/logo')).toBe(id)
    expect(await designIdForPath('design/other')).toBeNull()
  })
})

describe('injectDesignRuntime', () => {
  it('puts the bridge in the <head> without touching the <body>, only once', () => {
    const html = '<!doctype html><html><head><title>t</title></head><body><h1>Hi</h1></body></html>'
    const out = injectDesignRuntime(html)
    expect(out.indexOf(DESIGN_RUNTIME_PATH)).toBeLessThan(out.indexOf('<title>'))
    expect(out).toContain('<body><h1>Hi</h1></body>')
    expect(injectDesignRuntime(out)).toBe(out)
  })

  it('creates the <head> when it is missing, and covers a loose fragment', () => {
    expect(injectDesignRuntime('<html><body>x</body></html>')).toMatch(/^<html><head><script [^>]+><\/script><\/head><body>x/)
    expect(injectDesignRuntime('<div>x</div>')).toMatch(/^<script [^>]+><\/script><div>x<\/div>$/)
  })
})

describe('writeDesignBoard / readDesignBoard / updateDesignBoard', () => {
  it('saves the artboard and the arrangement, with the name and bounds locks', async () => {
    const folder = path.join(tempRoot, 'sess1', 'edit-canvas')
    await mkdir(folder, { recursive: true })
    await writeFile(
      path.join(folder, 'canvas.json'),
      JSON.stringify({ v: 1, boards: { 'Main.html': { x: 0, y: 0, w: 800, h: 600 } }, order: ['Main.html'] }),
      'utf8',
    )
    await writeFile(path.join(folder, 'Main.html'), '<p>a</p>', 'utf8')
    const { id } = await registerDesign(folder, { sessionId: 'sess1' })

    await writeDesignBoard(id, 'Main.html', '<p>b</p>')
    expect(await readDesignBoard(id, 'Main.html')).toBe('<p>b</p>')
    await expect(writeDesignBoard(id, '../escape.html', 'x')).rejects.toThrow(/invalid artboard/)
    await expect(writeDesignBoard('dsg_nope', 'Main.html', 'x')).rejects.toThrow(/unknown design/)

    await updateDesignBoard(id, 'Main.html', { x: 120.4, y: -40, w: 10, h: 99_999, title: 'Hero' })
    const { readDesignCanvas } = await import('./design-canvas')
    const canvas = await readDesignCanvas(folder)
    // w/h clamped to the canvas limits (40–8000), rounded position.
    expect(canvas.boards['Main.html']).toEqual({ x: 120, y: -40, w: 40, h: 8000, title: 'Hero' })
    await expect(updateDesignBoard(id, 'Other.html', { x: 1 })).rejects.toThrow(/not in canvas.json/)
  })
})

describe('registerDesignProtocol', () => {
  it('serves canvas.json and an artboard, and refuses what is outside the folder', async () => {
    const folder = path.join(tempRoot, 'sess1', 'proto-canvas')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'canvas.json'), '{"v":1,"boards":{"Main.html":{"x":0,"y":0,"w":800,"h":600}},"order":["Main.html"]}', 'utf8')
    await writeFile(path.join(folder, 'Main.html'), '<!doctype html><title>t</title><body>hi</body>', 'utf8')
    // Shared style sheet: a <link rel="stylesheet" href="base.css"> inside the
    // artboard resolves here, with the right type.
    await writeFile(path.join(folder, 'base.css'), ':root{--gap:8px}', 'utf8')

    registerDesignProtocol()
    const handler = registered.handlers.get('orbit-design')
    expect(handler).toBeTypeOf('function')

    const { id } = await registerDesign(folder, { sessionId: 'sess1' })

    const indexRes = await handler!(new Request(`orbit-design://${id}/canvas.json`))
    expect(indexRes.status).toBe(200)
    expect(await indexRes.text()).toContain('"Main.html"')

    const cssRes = await handler!(new Request(`orbit-design://${id}/base.css`))
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('Content-Type')).toContain('text/css')
    expect(await cssRes.text()).toBe(':root{--gap:8px}')

    const boardRes = await handler!(new Request(`orbit-design://${id}/Main.html`))
    expect(boardRes.status).toBe(200)
    expect(boardRes.headers.get('Content-Type')).toContain('text/html')
    const served = await boardRes.text()
    expect(served).toContain('hi')
    // The artboard comes out with the editor bridge; `?raw` is the source as it is on disk.
    // The bridge URL carries its version (it is what makes the cache immutable).
    expect(served).toContain(`${DESIGN_RUNTIME_PATH}?v=`)

    // ETag + revalidation: remounting an artboard without changes becomes a 304 with no body.
    const etag = boardRes.headers.get('ETag')
    expect(etag).toBeTruthy()
    expect(boardRes.headers.get('Cache-Control')).toBe('no-cache')
    const notModified = await handler!(new Request(`orbit-design://${id}/Main.html`, { headers: { 'If-None-Match': etag! } }))
    expect(notModified.status).toBe(304)

    const raw = await (await handler!(new Request(`orbit-design://${id}/Main.html?raw=1`))).text()
    expect(raw).not.toContain(DESIGN_RUNTIME_PATH)
    expect(raw).toBe('<!doctype html><title>t</title><body>hi</body>')

    // The file changed: the old etag no longer holds and the new body comes in full.
    await writeFile(path.join(folder, 'Main.html'), '<!doctype html><title>t</title><body>hi 2</body>', 'utf8')
    const changed = await handler!(new Request(`orbit-design://${id}/Main.html`, { headers: { 'If-None-Match': etag! } }))
    expect(changed.status).toBe(200)
    expect(await changed.text()).toContain('hi 2')

    const runtime = await handler!(new Request(`orbit-design://${id}${DESIGN_RUNTIME_PATH}`))
    expect(runtime.status).toBe(200)
    expect(runtime.headers.get('Content-Type')).toContain('javascript')
    // The bridge is a build constant and its URL carries the version.
    expect(runtime.headers.get('Cache-Control')).toContain('immutable')
    expect(await runtime.text()).toContain('orbit-design')

    const missing = await handler!(new Request(`orbit-design://${id}/nope.html`))
    expect(missing.status).toBe(404)

    const unknownId = await handler!(new Request('orbit-design://dsg_doesnotexist/canvas.json'))
    expect(unknownId.status).toBe(404)
  })
})

describe('watcher', () => {
  it('warns the window with the FILES that changed (the tab reloads only them)', async () => {
    const folder = path.join(tempRoot, 'sess1', 'watch-canvas')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'canvas.json'), '{"v":1,"boards":{},"order":[]}', 'utf8')
    const { id } = await registerDesign(folder, { sessionId: 'sess1' })

    const sent: Array<{ id: string; files?: string[] }> = []
    registered.windows.push({
      isDestroyed: () => false,
      webContents: { send: (_channel, payload) => sent.push(payload as { id: string; files?: string[] }) },
    })
    try {
      await writeFile(path.join(folder, 'Main.html'), '<p>a</p>', 'utf8')
      // The watcher debounce is 150 ms (ceiling of 400 in a burst): wait for the
      // payload to ARRIVE instead of sleeping a fixed value — fs.watch can lag
      // under load and a short wait makes the test flaky.
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !sent.some((item) => item.id === id)) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } finally {
      registered.windows.length = 0
    }

    const payload = sent.find((item) => item.id === id)
    expect(payload?.files).toContain('Main.html')
  })
})
