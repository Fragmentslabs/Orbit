import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** The handler the module registered: `protocol.handle` is mocked, but it keeps
 *  whoever arrived — it is through here that the tests call the scheme for real. */
const registered = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
}))

// The module touches `app`/`protocol` (it is from the main). The index falls in a temporary
// folder and no real protocol is registered.
vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-motion-store-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => [] },
    protocol: {
      handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
        registered.handlers.set(scheme, handler)
      },
    },
  }
})

const {
  deleteMotionComposition,
  getMotion,
  isMotionSourceChange,
  motionIdFor,
  motionIdForName,
  motionIdForPath,
  registerMotion,
  registerMotionProtocol,
  resolveMotionFile,
  unregisterMotion,
} = await import('./motion-store')

const tempRoot = path.join(os.tmpdir(), `orbit-motion-store-test-${process.pid}`)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('resolveMotionFile', () => {
  const folder = path.join('C:', 'proj', 'edit', 'motion', 'title')

  it('resolves a file inside the composition folder', () => {
    expect(resolveMotionFile(folder, '/title.html')).toBe(path.resolve(folder, 'title.html'))
    expect(resolveMotionFile(folder, '/assets/gsap.min.js')).toBe(path.resolve(folder, 'assets', 'gsap.min.js'))
    // The pathname arrives percent-encoded.
    expect(resolveMotionFile(folder, '/assets/fonte%20bold.woff2')).toBe(path.resolve(folder, 'assets', 'fonte bold.woff2'))
  })

  it('rejects `..` in any position, even percent-encoded', () => {
    expect(resolveMotionFile(folder, '../secret.html')).toBeNull()
    expect(resolveMotionFile(folder, '/../secret.html')).toBeNull()
    expect(resolveMotionFile(folder, '/assets/../../secret.html')).toBeNull()
    expect(resolveMotionFile(folder, '/..%2F..%2Fsecret.html')).toBeNull()
    expect(resolveMotionFile(folder, '/..\\..\\secret.html')).toBeNull()
  })

  it('rejects an absolute OS path and junk', () => {
    expect(resolveMotionFile(folder, 'C:/Windows/System32/evil.html')).toBeNull()
    expect(resolveMotionFile(folder, '/C:/Windows/evil.html')).toBeNull()
    expect(resolveMotionFile(folder, '/c:\\windows\\evil.html')).toBeNull()
    expect(resolveMotionFile(folder, '')).toBeNull()
    expect(resolveMotionFile(folder, '/')).toBeNull()
    expect(resolveMotionFile(folder, '/a%00b.html')).toBeNull()
  })
})

describe('isMotionSourceChange', () => {
  it('reloads for the composition sources and ignores renders and temp folders', () => {
    expect(isMotionSourceChange('index.html')).toBe(true)
    expect(isMotionSourceChange('assets\\font.woff2')).toBe(true)
    expect(isMotionSourceChange('hero.png')).toBe(true)
    expect(isMotionSourceChange(null)).toBe(true)
    expect(isMotionSourceChange('motion.mp4')).toBe(false)
    expect(isMotionSourceChange('final.MOV')).toBe(false)
    expect(isMotionSourceChange('.motion-abc123\\band_000.mp4')).toBe(false)
    expect(isMotionSourceChange('.motion-abc123/list.txt')).toBe(false)
  })
})

describe('motionIdForName — the conversation piece, addressed by name', () => {
  it('finds it by the folder that carries the name slug, inside the session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-chat-'))
    const folder = path.join(root, 'intro-do-orbit')
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, 'index.html')
    await writeFile(file, '<head></head>')
    const { id } = await registerMotion(folder, file, { sessionId: 'chat-a' })

    expect(await motionIdForName('chat-a', 'intro-do-orbit')).toBe(id)
    expect(await motionIdForName('chat-a', 'INTRO-DO-ORBIT')).toBe(id)
    // The same name in another conversation is ANOTHER piece: without the session in the key, the
    // card of one conversation would open the other's composition.
    expect(await motionIdForName('chat-b', 'intro-do-orbit')).toBeNull()
    expect(await motionIdForName('chat-a', 'other')).toBeNull()
    expect(await motionIdForName('chat-a', '   ')).toBeNull()

    await unregisterMotion(id)
    await rm(root, { recursive: true, force: true })
  })
})

describe('motionIdForPath — the path the tool received', () => {
  it('matches by the end of the path when it comes relative to the session folder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-rel-'))
    const folder = path.join(root, 'edit', 'animations', 'orbit-apresentacao')
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, 'index.html')
    await writeFile(file, '<head></head>')
    const { id } = await registerMotion(folder, file, { sessionId: 'chat-a' })

    // Absolute: exact, as always.
    expect(await motionIdForPath(file)).toBe(id)
    expect(await motionIdForPath(folder)).toBe(id)
    // Relative to the session's folder — what the agent really passes to the tool, and which
    // the main has no way of resolving (it does not know the session's folder).
    expect(await motionIdForPath('edit/animations/orbit-apresentacao/index.html')).toBe(id)
    expect(await motionIdForPath('edit/animations/orbit-apresentacao')).toBe(id)
    // A piece with no folder at all does not identify a piece: no matching by bare
    // name in the middle of a larger path.
    expect(await motionIdForPath('presentacao')).toBeNull()

    await unregisterMotion(id)
    await rm(root, { recursive: true, force: true })
  })
})

describe('registro', () => {
  it('registers a composition, reuses it and releases it on unregister', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-comp-'))
    await mkdir(path.join(folder, 'assets'), { recursive: true })
    await writeFile(path.join(folder, 'title.html'), '<head></head>')
    await writeFile(path.join(folder, 'assets', 'gsap.min.js'), '')

    const { id, url } = await registerMotion(folder, path.join(folder, 'title.html'), { root: os.tmpdir() })
    expect(id).toMatch(/^mv_[a-z0-9]+$/)
    expect(url).toBe(`orbit-motion://${id}/title.html`)

    const entry = await getMotion(id)
    expect(entry?.folder).toBe(path.resolve(folder))
    expect(entry?.entry).toBe(path.resolve(folder, 'title.html'))
    expect(entry?.root).toBe(path.resolve(os.tmpdir()))

    // Same folder + same session: reuses the id — including when only the
    // entry path is passed (the panel does not know the folder).
    const again = await registerMotion(folder, path.join(folder, 'title.html'), { root: os.tmpdir() })
    expect(again.id).toBe(id)
    const onlyEntry = await registerMotion(path.join(folder, 'title.html'), undefined, { root: os.tmpdir() })
    expect(onlyEntry.id).toBe(id)
    expect(onlyEntry.url).toBe(url)

    await unregisterMotion(id)
    expect(await getMotion(id)).toBeUndefined()
    await rm(folder, { recursive: true, force: true })
  })

  it('keeps the SAME id across sessions and only reports `created` the first time', async () => {
    // This was the tab's 404: the render registered the same composition, received the preview's
    // id and released it at the end. Now the id comes from folder + entry, and whoever did not
    // create the record learns it (created: false) so as not to release it.
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-comp-'))
    const file = path.join(folder, 'index.html')
    await writeFile(file, '<head></head>')
    const first = await registerMotion(folder, file, { sessionId: 'chat-a' })
    expect(first.created).toBe(true)
    expect(first.id).toBe(motionIdFor(folder, file))
    const other = await registerMotion(file, undefined, { sessionId: 'chat-b', root: folder })
    expect(other.id).toBe(first.id)
    expect(other.created).toBe(false)
    expect((await getMotion(first.id))?.sessionId).toBe('chat-b')
    await unregisterMotion(first.id)
    await rm(folder, { recursive: true, force: true })
  })

  it('refuses an entry outside the composition folder and an unknown id', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-comp-'))
    await expect(registerMotion(folder, path.join(os.tmpdir(), 'outside.html'))).rejects.toThrow(/outside the composition/)
    expect(await getMotion('mv_inexistente')).toBeUndefined()
    expect(await getMotion('../etc/passwd')).toBeUndefined()
    await rm(folder, { recursive: true, force: true })
  })
})

describe('protocolo', () => {
  /** A registered composition and the scheme handler already at hand. */
  async function serve(files: Record<string, string | Buffer>) {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-comp-'))
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(folder, name), content)
    const { id } = await registerMotion(folder, path.join(folder, 'index.html'), { root: os.tmpdir() })
    registerMotionProtocol()
    const handler = registered.handlers.get('orbit-motion')
    if (!handler) throw new Error('the orbit-motion scheme was not registered')
    return { folder, handler, url: (file: string) => `orbit-motion://${id}/${file}` }
  }

  it('serves the piece audio with a track — it is what lets the preview seek', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const { folder, handler, url } = await serve({ 'index.html': '<head></head>', 'voz.wav': bytes })

    const whole = await handler(new Request(url('voz.wav')))
    expect(whole.status).toBe(200)
    // Without this header Chromium treats the audio as NOT seekable: the sound plays
    // at the right minute, but `currentTime` becomes a suggestion and pausing in the middle
    // restarts the file from zero.
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(whole.headers.get('content-length')).toBe('10')
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(new Uint8Array(bytes))

    // The seek range: only the piece, with 206 and the declared range.
    const piece = await handler(new Request(url('voz.wav'), { headers: { range: 'bytes=2-5' } }))
    expect(piece.status).toBe(206)
    expect(piece.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(piece.headers.get('accept-ranges')).toBe('bytes')
    expect(piece.headers.get('content-length')).toBe('4')
    expect(new Uint8Array(await piece.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]))

    // Open (`bytes=4-`) and suffix (`bytes=-3`): it is how a player asks for the
    // duration of a format without a header.
    const open = await handler(new Request(url('voz.wav'), { headers: { range: 'bytes=4-' } }))
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6, 7, 8, 9]))
    const suffix = await handler(new Request(url('voz.wav'), { headers: { range: 'bytes=-3' } }))
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]))

    const past = await handler(new Request(url('voz.wav'), { headers: { range: 'bytes=50-60' } }))
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */10')

    await rm(folder, { recursive: true, force: true })
  })

  it('with the runtime injected, the HTML is no longer the file — and a track does not apply', async () => {
    const { folder, handler, url } = await serve({ 'index.html': '<html><head></head></html>' })

    const res = await handler(new Request(url('index.html'), { headers: { range: 'bytes=0-4' } }))
    expect(res.status).toBe(200)
    // The runtime enters as <script src> in the <head> — the marker is what proves the
    // injection (and it is what the HTML range cannot shift).
    expect(await res.text()).toContain('data-orbit-motion-runtime')

    await rm(folder, { recursive: true, force: true })
  })

  it('media goes out without `no-store`; the composition code stays uncached', async () => {
    const { folder, handler, url } = await serve({
      'index.html': '<head></head>',
      'voz.wav': Buffer.from([1, 2, 3, 4]),
      'app.js': 'export const a = 1',
    })

    // <audio> needs to be able to keep what it already downloaded: without that it redoes the
    // request at every repositioning, discards the buffer, and the sound stutters instead
    // of playing. It is what video/store.ts and audio-store.ts have always done.
    const media = await handler(new Request(url('voz.wav')))
    expect(media.status).toBe(200)
    expect(media.headers.get('cache-control')).toBeNull()
    expect(media.headers.get('accept-ranges')).toBe('bytes')

    // The JS is requested by the SAME URL at every reload — cache here would serve the old
    // version, and the live edit would not show up.
    const code = await handler(new Request(url('app.js')))
    expect(code.headers.get('cache-control')).toBe('no-store')

    await rm(folder, { recursive: true, force: true })
  })
})

describe('deleteMotionComposition', () => {
  const exists = (target: string) =>
    stat(target).then(
      () => true,
      () => false,
    )

  async function project(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), 'orbit-motion-delete-'))
  }

  async function composition(folder: string): Promise<string> {
    await mkdir(path.join(folder, 'assets'), { recursive: true })
    const entry = path.join(folder, 'index.html')
    await writeFile(entry, '<html></html>')
    await writeFile(path.join(folder, 'assets', 'clip.mp4'), 'video-bytes')
    return entry
  }

  it('deletes the whole composition folder (with what was copied into it) and unregisters it', async () => {
    const root = await project()
    const folder = path.join(root, 'edit', 'animations', 'intro')
    const entry = await composition(folder)
    const renders = path.join(root, 'edit', 'renders')
    await mkdir(renders, { recursive: true })
    await writeFile(path.join(renders, 'intro.mp4'), 'render')
    const { id } = await registerMotion(folder, entry, { root })

    const result = await deleteMotionComposition(id)

    expect(result).toEqual({ removedFolder: true })
    expect(await exists(folder)).toBe(false)
    expect(await getMotion(id)).toBeUndefined()
    // What the user rendered stays outside the composition's folder and is not touched.
    expect(await readdir(renders)).toEqual(['intro.mp4'])
    await rm(root, { recursive: true, force: true })
  })

  it('a composition that IS the project (index.html at the root) leaves the registry, but the folder stays', async () => {
    const root = await project()
    const entry = await composition(root)
    await writeFile(path.join(root, 'package.json'), '{}')
    const { id } = await registerMotion(root, entry, { root })

    const result = await deleteMotionComposition(id)

    expect(result.removedFolder).toBe(false)
    expect(result.keptBecause).toMatch(/project itself/)
    expect(await exists(path.join(root, 'package.json'))).toBe(true)
    expect(await getMotion(id)).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  it('the chat-mode folder belongs to Orbit: it deletes even with no work folder registered', async () => {
    const folder = path.join(tempRoot, 'orbit-data', 'motion', 'sess1', 'minha-peca')
    const entry = await composition(folder)
    const { id } = await registerMotion(folder, entry)

    expect(await deleteMotionComposition(id)).toEqual({ removedFolder: true })
    expect(await exists(folder)).toBe(false)
  })

  it('outside any place the app may clean, the folder stays', async () => {
    const root = await project()
    const elsewhere = await project()
    const entry = await composition(elsewhere)
    const { id } = await registerMotion(elsewhere, entry, { root })

    const result = await deleteMotionComposition(id)

    expect(result.removedFolder).toBe(false)
    expect(await exists(entry)).toBe(true)
    expect(await getMotion(id)).toBeUndefined()
    await rm(root, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  })

  it('with no real composition in the folder (entry gone), nothing is deleted', async () => {
    const root = await project()
    const folder = path.join(root, 'edit', 'animations', 'vazia')
    const entry = await composition(folder)
    const { id } = await registerMotion(folder, entry, { root })
    await rm(entry)
    await writeFile(path.join(folder, 'user-notes.txt'), 'importante')

    const result = await deleteMotionComposition(id)

    expect(result.keptBecause).toMatch(/entry/)
    expect(await exists(path.join(folder, 'user-notes.txt'))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('an unknown id does nothing', async () => {
    expect(await deleteMotionComposition('mv_000000000000dead')).toEqual({ removedFolder: false, keptBecause: 'not registered' })
  })
})
