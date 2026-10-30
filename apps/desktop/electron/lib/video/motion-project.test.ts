import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Taking a piece from one conversation to another: the whole folder in a .zip, with a
 * manifest that identifies it. What this test protects is the promise of
 * "import": the HTML and the files arrive intact, NOTHING is overwritten — and the
 * same zip can come back twice, each time as an independent piece.
 */

const userData = path.join(os.tmpdir(), `orbit-motion-project-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

let project: typeof import('./motion-project')
let store: typeof import('./motion-store')

const ORIGIN = 'sess-origem'
const TARGET = 'sess-destino'
const HTML =
  '<!doctype html><html><head><meta name="orbit-motion" content="width=1080,height=1920,fps=30,duration=4"></head>' +
  '<body><video src="clipe.mp4"></video></body></html>'

let folder: string

beforeAll(async () => {
  project = await import('./motion-project')
  store = await import('./motion-store')
  folder = path.join(userData, 'orbit-data', 'motion', ORIGIN, 'intro')
  await fsp.mkdir(path.join(folder, 'fonts'), { recursive: true })
  await fsp.writeFile(path.join(folder, 'index.html'), HTML)
  await fsp.writeFile(path.join(folder, 'clipe.mp4'), Buffer.alloc(256, 7))
  await fsp.writeFile(path.join(folder, 'fonts', 'inter.woff2'), Buffer.alloc(32, 3))
  await fsp.writeFile(path.join(folder, 'audio.json'), JSON.stringify({ tracks: [] }))
  await fsp.writeFile(path.join(folder, '.DS_Store'), 'lixo')
  await store.registerMotion(folder, path.join(folder, 'index.html'), {
    root: path.join(userData, 'orbit-data', 'motion', ORIGIN),
    sessionId: ORIGIN,
  })
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

async function exportIntro(): Promise<Buffer> {
  const { buffer } = await project.exportMotionProject(store.motionIdFor(folder, path.join(folder, 'index.html')))
  return buffer
}

describe('exportMotionProject', () => {
  it('takes the whole piece and a manifest with name, format and the file list', async () => {
    const buffer = await exportIntro()
    const entries = unzipSync(new Uint8Array(buffer))
    const manifest = JSON.parse(Buffer.from(entries['orbit.json']).toString('utf8'))
    expect(manifest.kind).toBe('orbit-motion-project')
    expect(manifest.version).toBe(1)
    expect(manifest.name).toBe('intro')
    expect(manifest.entry).toBe('index.html')
    // The format comes from the composition's own <meta>.
    expect(manifest.format).toMatchObject({ width: 1080, height: 1920, fps: 30, durationInFrames: 120 })
    expect(manifest.files).toContain('clipe.mp4')
    expect(manifest.files).toContain('fonts/inter.woff2')
    expect(manifest.files).toContain('orbit.json')
    // The system's junk does not travel.
    expect(Object.keys(entries)).not.toContain('.DS_Store')
    expect(Buffer.from(entries['clipe.mp4']).length).toBe(256)
  })

  it('a zip of anything else is not recognized as a project', () => {
    const other = zipSync({ 'leiame.txt': strToU8('oi') })
    expect(project.readMotionProject(Buffer.from(other))).toBeNull()
    expect(project.readMotionProject(Buffer.from('is not even a zip'))).toBeNull()
  })
})

describe('importMotionProject', () => {
  it('recreates the piece with a new id, HTML and files intact', async () => {
    const buffer = await exportIntro()
    const imported = await project.importMotionProject(buffer, { sessionId: TARGET })
    expect(imported.name).toBe('intro')
    expect(imported.folder.startsWith(path.join(userData, 'orbit-data', 'motion', TARGET))).toBe(true)
    expect(await fsp.readFile(path.join(imported.folder, 'index.html'), 'utf8')).toBe(HTML)
    expect((await fsp.readFile(path.join(imported.folder, 'clipe.mp4'))).length).toBe(256)
    expect((await fsp.readFile(path.join(imported.folder, 'fonts', 'inter.woff2'))).length).toBe(32)
    // The manifest is the ZIP's, not the recreated folder's.
    await expect(fsp.access(path.join(imported.folder, 'orbit.json'))).rejects.toThrow()
    const registered = await store.getMotion(imported.id)
    expect(registered?.folder).toBe(imported.folder)
    expect(registered?.sessionId).toBe(TARGET)
  })

  it('importing twice does not overwrite: they are two independent pieces', async () => {
    const buffer = await exportIntro()
    const first = await project.importMotionProject(buffer, { sessionId: TARGET })
    const second = await project.importMotionProject(buffer, { sessionId: TARGET })
    expect(second.id).not.toBe(first.id)
    expect(second.folder).not.toBe(first.folder)
    // The name gets a suffix instead of overwriting the piece that is already there.
    expect(second.name).toMatch(/^intro-\d+$/)
    expect(await store.getMotion(first.id)).toBeDefined()
    expect(await store.getMotion(second.id)).toBeDefined()
  })

  it('refuses a zip with no manifest and a zip with a path that escapes the folder', async () => {
    const plain = zipSync({ 'index.html': strToU8('<html></html>') })
    await expect(
      project.importMotionProject(Buffer.from(plain), { sessionId: TARGET }),
    ).rejects.toThrow(/not a motion project/)

    const manifest = {
      kind: 'orbit-motion-project',
      version: 1,
      name: 'malicioso',
      createdAt: Date.now(),
      entry: 'index.html',
      format: null,
      files: ['index.html'],
    }
    const evil = zipSync({
      'orbit.json': strToU8(JSON.stringify(manifest)),
      'index.html': strToU8('<html></html>'),
      '../../fora.txt': strToU8('vazou'),
    })
    const imported = await project.importMotionProject(Buffer.from(evil), { sessionId: TARGET })
    // What escapes is simply ignored — and the piece comes in right.
    expect((await fsp.readFile(path.join(imported.folder, 'index.html'), 'utf8')).length).toBeGreaterThan(0)
    await expect(fsp.access(path.join(userData, 'orbit-data', 'fora.txt'))).rejects.toThrow()
  })

  it('refuses a future-version manifest instead of importing halfway', () => {
    const manifest = {
      kind: 'orbit-motion-project',
      version: 99,
      name: 'futuro',
      createdAt: Date.now(),
      entry: 'index.html',
      format: null,
      files: ['index.html'],
    }
    const zip = zipSync({ 'orbit.json': strToU8(JSON.stringify(manifest)), 'index.html': strToU8('<html></html>') })
    expect(project.readMotionProject(Buffer.from(zip))).toBeNull()
  })

  it('a zip inside a folder (Finder sometimes wraps it) goes in the same way', async () => {
    const buffer = await exportIntro()
    const entries = unzipSync(new Uint8Array(buffer))
    const wrapped: Record<string, Uint8Array> = {}
    for (const [name, data] of Object.entries(entries)) wrapped[`pacote/${name}`] = data
    const imported = await project.importMotionProject(Buffer.from(zipSync(wrapped)), { sessionId: TARGET })
    expect(await fsp.readFile(path.join(imported.folder, 'index.html'), 'utf8')).toBe(HTML)
  })
})

describe('safeZipEntry', () => {
  it('only returns a relative path, with no `..`, no system name', () => {
    expect(project.safeZipEntry('', 'index.html')).toBe('index.html')
    expect(project.safeZipEntry('pacote/', 'pacote/index.html')).toBe('index.html')
    expect(project.safeZipEntry('', '../fora.txt')).toBeNull()
    expect(project.safeZipEntry('', '/etc/passwd')).toBeNull()
    expect(project.safeZipEntry('', 'a/../../b.txt')).toBeNull()
    expect(project.safeZipEntry('', '.DS_Store')).toBeNull()
    expect(project.safeZipEntry('', '__MACOSX/x')).toBeNull()
    expect(project.safeZipEntry('', 'orbit.json')).toBeNull()
  })
})
