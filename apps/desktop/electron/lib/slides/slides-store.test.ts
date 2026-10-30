import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** Mirrors design-store.test.ts: `protocol.handle` is mocked, but it keeps track of who
 *  arrived — this is how the test calls the scheme for real. */
const registered = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
}))

vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-slides-store-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => [] },
    protocol: {
      handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
        registered.handlers.set(scheme, handler)
      },
    },
  }
})

const {
  slidesPiecesDir,
  slidesPiecesRoot,
  deleteSlidesDeck,
  getSlides,
  isSlidesSourceChange,
  registerSlides,
  registerSlidesProtocol,
  resolveSlidesFile,
  slidesIdFor,
  slidesIdForName,
  slidesIdForPath,
  unregisterSlides,
} = await import('./slides-store')
const { SLIDES_RUNTIME_PATH, injectSlidesRuntime } = await import('./slides-runtime')

const tempRoot = path.join(os.tmpdir(), `orbit-slides-store-test-${process.pid}`)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('resolveSlidesFile', () => {
  const folder = path.join('C:', 'orbit-data', 'slides', 'sess1', 'deck')

  it('resolves a file inside the deck folder', () => {
    expect(resolveSlidesFile(folder, '/index.html')).toBe(path.resolve(folder, 'index.html'))
    expect(resolveSlidesFile(folder, '/assets/fundo%20final.png')).toBe(path.resolve(folder, 'assets', 'fundo final.png'))
  })

  it('refuses `..` in any position, including percent-encoded', () => {
    expect(resolveSlidesFile(folder, '../secret.html')).toBeNull()
    expect(resolveSlidesFile(folder, '/../secret.html')).toBeNull()
    expect(resolveSlidesFile(folder, '/..%2F..%2Fsecret.html')).toBeNull()
  })

  it('refuses a system absolute path and junk', () => {
    expect(resolveSlidesFile(folder, 'C:/Windows/System32/evil.html')).toBeNull()
    expect(resolveSlidesFile(folder, '')).toBeNull()
    expect(resolveSlidesFile(folder, '/')).toBeNull()
    expect(resolveSlidesFile(folder, '/a%00b.html')).toBeNull()
  })
})

describe('slidesIdFor', () => {
  it('is deterministic for the same folder + entry', () => {
    const a = slidesIdFor('C:/proj/slides/deck', 'C:/proj/slides/deck/index.html')
    const b = slidesIdFor('C:/proj/slides/deck', 'C:/proj/slides/deck/index.html')
    expect(a).toBe(b)
    expect(a).toMatch(/^sld_[a-z0-9]+$/)
  })

  it('differs for different folders', () => {
    expect(slidesIdFor('C:/proj/a', 'C:/proj/a/index.html')).not.toBe(
      slidesIdFor('C:/proj/b', 'C:/proj/b/index.html'),
    )
  })
})

describe('registerSlides / getSlides / unregisterSlides', () => {
  it('a folder becomes its own index.html, and the entry may be explicit', async () => {
    const folder = path.join(tempRoot, 'sess1', 'deck-a')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<section class="slide"><h1>A</h1></section>', 'utf8')
    await writeFile(path.join(folder, 'other.html'), '<section class="slide"><h1>B</h1></section>', 'utf8')

    const reg = await registerSlides(folder, { sessionId: 'sess1' })
    expect(reg.created).toBe(true)
    expect(reg.entry).toBe(path.join(folder, 'index.html'))
    expect(reg.url).toMatch(/^orbit-slides:\/\/sld_[a-z0-9]+\/index\.html$/)

    const entry = await getSlides(reg.id)
    expect(entry?.folder).toBe(path.resolve(folder))
    expect(entry?.sessionId).toBe('sess1')

    // Only the .html, when it is the file the agent pointed to.
    const other = await registerSlides(path.join(folder, 'other.html'), { sessionId: 'sess1' })
    expect(other.entry).toBe(path.join(folder, 'other.html'))
    expect(other.id).not.toBe(reg.id)

    // Idempotent.
    const again = await registerSlides(folder, { sessionId: 'sess1' })
    expect(again.id).toBe(reg.id)
    expect(again.created).toBe(false)

    await unregisterSlides(reg.id)
    expect(await getSlides(reg.id)).toBeUndefined()
  })

  it('refuses an entry outside the folder', async () => {
    const folder = path.join(tempRoot, 'sess1', 'deck-fora')
    await mkdir(folder, { recursive: true })
    await expect(registerSlides(folder, { entry: path.join(tempRoot, 'alheio.html') })).rejects.toThrow(/outside/)
  })
})

describe('slidesIdForName / slidesIdForPath', () => {
  it('finds by name in the session and by the path, including by the end of the path', async () => {
    const folder = path.join(tempRoot, 'proj', 'slides', 'pitch')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<section class="slide"><h1>P</h1></section>', 'utf8')
    const { id } = await registerSlides(folder, { root: path.join(tempRoot, 'proj'), sessionId: 'sess9' })

    expect(await slidesIdForName('sess9', 'pitch')).toBe(id)
    expect(await slidesIdForName('sess9', 'other')).toBeNull()
    expect(await slidesIdForName('sess2', 'pitch')).toBeNull()

    expect(await slidesIdForPath(folder)).toBe(id)
    expect(await slidesIdForPath(path.join(folder, 'index.html'))).toBe(id)
    expect(await slidesIdForPath('slides/pitch')).toBe(id)
    expect(await slidesIdForPath('slides/none')).toBeNull()
  })

  it('the card TITLE finds the folder by the slug (chat)', async () => {
    const folder = path.join(tempRoot, 'sess-titulo', 'orbit-em-12-slides')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<section class="slide"><h1>T</h1></section>', 'utf8')
    const { id } = await registerSlides(folder, { sessionId: 'sessT' })

    // The card sends the title as the user wrote it; the folder is the slug.
    expect(await slidesIdForName('sessT', 'Orbit em 12 slides')).toBe(id)
    expect(await slidesIdForName('sessT', 'Orbit em 12 Slides')).toBe(id)
    expect(await slidesIdForName('sessT', 'Another deck')).toBeNull()
  })
})

describe('injectSlidesRuntime', () => {
  it('puts the runtime before the content, only once, and does not touch the body', () => {
    const html = '<!doctype html><html><head><title>t</title></head><body><h1>Oi</h1></body></html>'
    const out = injectSlidesRuntime(html)
    expect(out.indexOf(SLIDES_RUNTIME_PATH)).toBeLessThan(out.indexOf('<title>'))
    expect(out).toContain('<body><h1>Oi</h1></body>')
    expect(injectSlidesRuntime(out)).toBe(out)
  })

  it('creates the <head> when it is missing, and covers the loose fragment', () => {
    expect(injectSlidesRuntime('<html><body>x</body></html>')).toMatch(/^<html><head><script [^>]+><\/script><\/head><body>x/)
    expect(injectSlidesRuntime('<div>x</div>')).toMatch(/^<script [^>]+><\/script><div>x<\/div>$/)
  })
})

describe('registerSlidesProtocol', () => {
  it('serves the deck with the runtime and returns the raw source at ?raw', async () => {
    const folder = path.join(tempRoot, 'sess1', 'proto-deck')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<!doctype html><title>t</title><body>slide</body>', 'utf8')

    registerSlidesProtocol()
    const handler = registered.handlers.get('orbit-slides')
    expect(handler).toBeTypeOf('function')

    const { id } = await registerSlides(folder, { sessionId: 'sess1' })

    const served = await handler!(new Request(`orbit-slides://${id}/index.html`))
    expect(served.status).toBe(200)
    expect(served.headers.get('Content-Type')).toContain('text/html')
    expect(await served.text()).toContain(SLIDES_RUNTIME_PATH)

    const raw = await handler!(new Request(`orbit-slides://${id}/index.html?raw=1`))
    expect(raw.status).toBe(200)
    expect(await raw.text()).toBe('<!doctype html><title>t</title><body>slide</body>')

    const runtime = await handler!(new Request(`orbit-slides://${id}${SLIDES_RUNTIME_PATH}`))
    expect(runtime.status).toBe(200)
    expect(runtime.headers.get('Content-Type')).toContain('javascript')
    expect(await runtime.text()).toContain('orbit-slides')

    // An id that does not exist plus folder escape: 404, never the file.
    expect((await handler!(new Request('orbit-slides://sld_nope/index.html'))).status).toBe(404)
    expect((await handler!(new Request(`orbit-slides://${id}/../secret.html`))).status).toBe(404)
  })
})

describe('isSlidesSourceChange', () => {
  it('ignores exports and temporaries, accepts what is source', () => {
    expect(isSlidesSourceChange('index.html')).toBe(true)
    expect(isSlidesSourceChange('assets/fundo.png')).toBe(true)
    expect(isSlidesSourceChange('deck.pdf')).toBe(false)
    expect(isSlidesSourceChange('render.mp4')).toBe(false)
    expect(isSlidesSourceChange('.slides-tmp/index.html')).toBe(false)
    expect(isSlidesSourceChange(null)).toBe(true)
  })
})

describe('slidesPiecesDir / deleteSlidesDeck', () => {
  const stat = async (target: string) => (await import('node:fs/promises')).stat(target)

  async function deckAt(folder: string, opts: { root?: string } = {}) {
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<section class="slide"><h1>X</h1></section>', 'utf8')
    return registerSlides(folder, { ...opts, sessionId: 'sess-del' })
  }

  it('the chat folder lives under the app root, with the session id validated', () => {
    expect(slidesPiecesDir('sess-del')).toBe(path.join(slidesPiecesRoot(), 'sess-del'))
    expect(() => slidesPiecesDir('../fuga')).toThrow(/invalid session id/)
  })

  it('deletes a chat deck folder, and the registry goes with it', async () => {
    const reg = await deckAt(slidesPiecesDir('sess-del'))
    const out = await deleteSlidesDeck(reg.id)
    expect(out.removedFolder).toBe(true)
    expect(await getSlides(reg.id)).toBeUndefined()
    await expect(stat(reg.folder)).rejects.toBeTruthy()
  })

  it('deletes the deck folder INSIDE the project, never the project', async () => {
    const project = path.join(tempRoot, 'projeto')
    const reg = await deckAt(path.join(project, 'slides', 'deck'), { root: project })
    expect((await deleteSlidesDeck(reg.id)).removedFolder).toBe(true)
    // The project is still standing — it is what separates "freeing space" from "destroying".
    expect((await stat(project)).isDirectory()).toBe(true)
  })

  it('refuses to delete the project root, but drops the registry', async () => {
    const project = path.join(tempRoot, 'projeto-raiz')
    await mkdir(project, { recursive: true })
    await writeFile(path.join(project, 'index.html'), '<section class="slide"><h1>X</h1></section>', 'utf8')
    const reg = await registerSlides(project, { root: project, sessionId: 'sess-del' })
    const out = await deleteSlidesDeck(reg.id)
    expect(out.removedFolder).toBe(false)
    expect(out.keptBecause).toContain('project itself')
    expect((await stat(project)).isDirectory()).toBe(true)
    expect(await getSlides(reg.id)).toBeUndefined()
  })

  it('a deck outside the registry deletes nothing', async () => {
    expect(await deleteSlidesDeck('sld_nada')).toEqual({ removedFolder: false, keptBecause: 'not registered' })
  })
})
