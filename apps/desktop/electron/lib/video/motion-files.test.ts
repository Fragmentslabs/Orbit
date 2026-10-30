import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The piece card needs to know three things about each file: that it exists, whether
 * the composition CITES it (used) or not (discarded), and from which chat media it
 * came — the last one is what turns a loose player into a line of the card.
 *
 * "Used" is derived from the composition's text on purpose: when the agent
 * swaps the narration in `audio.json`, the old file becomes discarded by itself.
 */

const userData = path.join(os.tmpdir(), `orbit-motion-files-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

let files: typeof import('./motion-files')
let store: typeof import('./motion-store')

const SESSION = 'sess-files'
let root: string
let folder: string

beforeAll(async () => {
  files = await import('./motion-files')
  store = await import('./motion-store')
  root = path.join(userData, 'orbit-data', 'motion', SESSION)
  folder = path.join(root, 'intro')
  await fsp.mkdir(path.join(folder, 'fonts'), { recursive: true })
  await fsp.writeFile(path.join(folder, 'index.html'), '<video src="clipe.mp4"></video><style>@font-face{src:url("fonts/inter.woff2")}</style>')
  await fsp.writeFile(path.join(folder, 'audio.json'), JSON.stringify({ tracks: [{ src: 'narracao.wav' }] }))
  await fsp.writeFile(path.join(folder, 'clipe.mp4'), Buffer.alloc(64))
  await fsp.writeFile(path.join(folder, 'narracao.wav'), Buffer.alloc(32))
  // The old one: `audio.json` does not speak of it.
  await fsp.writeFile(path.join(folder, 'narracao-2.wav'), Buffer.alloc(16))
  await fsp.writeFile(path.join(folder, 'fonts', 'inter.woff2'), Buffer.alloc(8))
  await fsp.writeFile(path.join(folder, '.DS_Store'), 'x')
  await store.registerMotion(folder, path.join(folder, 'index.html'), { root, sessionId: SESSION })
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('listMotionBundles', () => {
  it('lists the piece folder, without the internal files, with used/unused', async () => {
    const [bundle] = await files.listMotionBundles(SESSION)
    expect(bundle.name).toBe('intro')
    const byName = Object.fromEntries(bundle.files.map((file) => [file.name, file]))
    // index.html is the piece, audio.json is a manifest: neither one is an item of the list.
    expect(byName['index.html']).toBeUndefined()
    expect(byName['audio.json']).toBeUndefined()
    expect(byName['.DS_Store']).toBeUndefined()
    expect(byName['clipe.mp4'].used).toBe(true)
    expect(byName['narracao.wav'].used).toBe(true)
    // Cited only in the HTML, by relative path.
    expect(byName['fonts/inter.woff2'].used).toBe(true)
    // The narration the composition does not cite: it stays in the folder, labelled.
    expect(byName['narracao-2.wav'].used).toBe(false)
    expect(bundle.discarded).toBe(1)
    expect(bundle.totalBytes).toBe(64 + 32 + 16 + 8)
    expect(bundle.files.find((file) => file.name === 'clipe.mp4')?.kind).toBe('video')
    expect(bundle.files.find((file) => file.name === 'narracao.wav')?.kind).toBe('audio')
    expect(bundle.files.find((file) => file.name === 'fonts/inter.woff2')?.kind).toBe('font')
  })

  it('the composition changes → the file state changes with it, with nobody marking anything', async () => {
    const audioFile = path.join(folder, 'audio.json')
    const before = await fsp.readFile(audioFile, 'utf8')
    await fsp.writeFile(audioFile, JSON.stringify({ tracks: [{ src: 'narracao-2.wav' }] }))
    try {
      const [bundle] = await files.listMotionBundles(SESSION)
      const byName = Object.fromEntries(bundle.files.map((file) => [file.name, file]))
      expect(byName['narracao-2.wav'].used).toBe(true)
      expect(byName['narracao.wav'].used).toBe(false)
    } finally {
      await fsp.writeFile(audioFile, before)
    }
  })

  it('with no piece registered in the session, no card', async () => {
    expect(await files.listMotionBundles('outra-sessao')).toEqual([])
  })

  it('the origin of each file becomes the chat key', async () => {
    const id = store.motionIdFor(folder, path.join(folder, 'index.html'))
    await files.recordMotionFile(
      { id, folder, sessionId: SESSION },
      { name: 'narracao.wav', ref: 'aud_abc.wav' },
    )
    await files.recordMotionFile(
      { id, folder, sessionId: SESSION },
      { name: 'clipe.mp4', source: '/tmp/projeto/clipe.mp4' },
    )
    const [bundle] = await files.listMotionBundles(SESSION)
    expect(bundle.keys).toContain('aud_abc.wav')
    expect(bundle.keys).toContain('/tmp/projeto/clipe.mp4')
  })

  it('registering the same file again does not duplicate the origin nor erase the previous one', async () => {
    const id = store.motionIdFor(folder, path.join(folder, 'index.html'))
    // The re-recorded narration that landed on the same name: both messages of the
    // conversation keep pointing at the file.
    await files.recordMotionFile({ id, folder, sessionId: SESSION }, { name: 'narracao.wav', ref: 'aud_def.wav' })
    await files.recordMotionFile({ id, folder, sessionId: SESSION }, { name: 'narracao.wav', ref: 'aud_def.wav' })
    const [bundle] = await files.listMotionBundles(SESSION)
    expect(bundle.keys).toContain('aud_abc.wav')
    expect(bundle.keys).toContain('aud_def.wav')
    expect(bundle.keys.filter((key) => key === 'aud_def.wav')).toHaveLength(1)
  })

  it('a deleted piece takes the origin with it (the reopened folder is a new piece)', async () => {
    const id = store.motionIdFor(folder, path.join(folder, 'index.html'))
    await store.unregisterMotion(id)
    const rebuilt = await store.registerMotion(folder, path.join(folder, 'index.html'), { root, sessionId: SESSION })
    const [bundle] = await files.listMotionBundles(SESSION)
    expect(rebuilt.id).toBe(id)
    expect(bundle.keys).not.toContain('aud_abc.wav')
  })
})

describe('mentionsFile', () => {
  it('the file must show up as a file, not as part of another word', () => {
    expect(files.mentionsFile('<img src="foto.png">', 'foto.png')).toBe(true)
    expect(files.mentionsFile('url(./foto.png)', 'foto.png')).toBe(true)
    expect(files.mentionsFile('{"src":"foto.png"}', 'foto.png')).toBe(true)
    // Another file that ENDS with the name does not cite the name.
    expect(files.mentionsFile('src="minha-foto.png"', 'foto.png')).toBe(false)
    expect(files.mentionsFile('src="foto.png.bak"', 'foto.png')).toBe(false)
  })

  it('a path with a subfolder counts by the whole path or by the loose name', () => {
    expect(files.mentionsFile('src="fonts/inter.woff2"', 'fonts/inter.woff2')).toBe(true)
    expect(files.mentionsFile('src="inter.woff2"', 'fonts/inter.woff2')).toBe(true)
    expect(files.mentionsFile('src="fonts/outra.woff2"', 'fonts/inter.woff2')).toBe(false)
  })

  it('a name with a space also counts in the form that travels in a URL', () => {
    expect(files.mentionsFile('src="minha%20narracao.wav"', 'minha narracao.wav')).toBe(true)
  })
})

describe('pieceFileName', () => {
  it('only accepts a path inside the folder', () => {
    expect(files.pieceFileName('/a/b', '/a/b/c/d.wav')).toBe('c/d.wav')
    expect(files.pieceFileName('/a/b', '/a/b')).toBeNull()
    expect(files.pieceFileName('/a/b', '/a/c/d.wav')).toBeNull()
    expect(files.pieceFileName('/a/b', '/a/b/../d.wav')).toBeNull()
  })
})
