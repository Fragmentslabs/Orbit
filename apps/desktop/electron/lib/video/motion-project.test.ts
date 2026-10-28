import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Levar uma peça de uma conversa para outra: a pasta inteira num .zip, com um
 * manifesto que a identifica. O que este teste protege é a promessa do
 * "importar": o HTML e os arquivos chegam intactos, NADA é sobrescrito — e o
 * mesmo zip pode voltar duas vezes, cada vez como uma peça independente.
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
  it('leva a peça inteira e um manifesto com nome, formato e a lista de arquivos', async () => {
    const buffer = await exportIntro()
    const entries = unzipSync(new Uint8Array(buffer))
    const manifest = JSON.parse(Buffer.from(entries['orbit.json']).toString('utf8'))
    expect(manifest.kind).toBe('orbit-motion-project')
    expect(manifest.version).toBe(1)
    expect(manifest.name).toBe('intro')
    expect(manifest.entry).toBe('index.html')
    // O formato sai do <meta> da própria composição.
    expect(manifest.format).toMatchObject({ width: 1080, height: 1920, fps: 30, durationInFrames: 120 })
    expect(manifest.files).toContain('clipe.mp4')
    expect(manifest.files).toContain('fonts/inter.woff2')
    expect(manifest.files).toContain('orbit.json')
    // O lixo do sistema não viaja.
    expect(Object.keys(entries)).not.toContain('.DS_Store')
    expect(Buffer.from(entries['clipe.mp4']).length).toBe(256)
  })

  it('zip de qualquer outra coisa não é reconhecido como projeto', () => {
    const outro = zipSync({ 'leiame.txt': strToU8('oi') })
    expect(project.readMotionProject(Buffer.from(outro))).toBeNull()
    expect(project.readMotionProject(Buffer.from('nem é zip'))).toBeNull()
  })
})

describe('importMotionProject', () => {
  it('recria a peça com id novo, HTML e arquivos intactos', async () => {
    const buffer = await exportIntro()
    const imported = await project.importMotionProject(buffer, { sessionId: TARGET })
    expect(imported.name).toBe('intro')
    expect(imported.folder.startsWith(path.join(userData, 'orbit-data', 'motion', TARGET))).toBe(true)
    expect(await fsp.readFile(path.join(imported.folder, 'index.html'), 'utf8')).toBe(HTML)
    expect((await fsp.readFile(path.join(imported.folder, 'clipe.mp4'))).length).toBe(256)
    expect((await fsp.readFile(path.join(imported.folder, 'fonts', 'inter.woff2'))).length).toBe(32)
    // O manifesto é do ZIP, não da pasta recriada.
    await expect(fsp.access(path.join(imported.folder, 'orbit.json'))).rejects.toThrow()
    const registered = await store.getMotion(imported.id)
    expect(registered?.folder).toBe(imported.folder)
    expect(registered?.sessionId).toBe(TARGET)
  })

  it('importar duas vezes não sobrescreve: são duas peças independentes', async () => {
    const buffer = await exportIntro()
    const first = await project.importMotionProject(buffer, { sessionId: TARGET })
    const second = await project.importMotionProject(buffer, { sessionId: TARGET })
    expect(second.id).not.toBe(first.id)
    expect(second.folder).not.toBe(first.folder)
    // O nome ganha sufixo em vez de sobrescrever a peça que já está lá.
    expect(second.name).toMatch(/^intro-\d+$/)
    expect(await store.getMotion(first.id)).toBeDefined()
    expect(await store.getMotion(second.id)).toBeDefined()
  })

  it('recusa zip sem manifesto e zip com caminho que escapa da pasta', async () => {
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
    // O que escapa é simplesmente ignorado — e a peça entra certa.
    expect((await fsp.readFile(path.join(imported.folder, 'index.html'), 'utf8')).length).toBeGreaterThan(0)
    await expect(fsp.access(path.join(userData, 'orbit-data', 'fora.txt'))).rejects.toThrow()
  })

  it('recusa manifesto de versão futura em vez de importar pela metade', () => {
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

  it('zip dentro de uma pasta (o Finder às vezes embrulha) entra igual', async () => {
    const buffer = await exportIntro()
    const entries = unzipSync(new Uint8Array(buffer))
    const wrapped: Record<string, Uint8Array> = {}
    for (const [name, data] of Object.entries(entries)) wrapped[`pacote/${name}`] = data
    const imported = await project.importMotionProject(Buffer.from(zipSync(wrapped)), { sessionId: TARGET })
    expect(await fsp.readFile(path.join(imported.folder, 'index.html'), 'utf8')).toBe(HTML)
  })
})

describe('safeZipEntry', () => {
  it('só devolve caminho relativo, sem `..`, sem nome de sistema', () => {
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
