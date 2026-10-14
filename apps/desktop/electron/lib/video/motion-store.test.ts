import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// O módulo toca em `app`/`protocol` (é do main). O índice cai numa pasta
// temporária e nenhum protocolo real é registrado.
vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-motion-store-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => [] },
    protocol: { handle: () => {} },
  }
})

const { getMotion, isMotionSourceChange, motionIdFor, registerMotion, resolveMotionFile, unregisterMotion } = await import(
  './motion-store'
)

const tempRoot = path.join(os.tmpdir(), `orbit-motion-store-test-${process.pid}`)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('resolveMotionFile', () => {
  const folder = path.join('C:', 'proj', 'edit', 'motion', 'title')

  it('resolves a file inside the composition folder', () => {
    expect(resolveMotionFile(folder, '/title.html')).toBe(path.resolve(folder, 'title.html'))
    expect(resolveMotionFile(folder, '/assets/gsap.min.js')).toBe(path.resolve(folder, 'assets', 'gsap.min.js'))
    // O pathname chega percent-encoded.
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

    // Mesma pasta + mesma sessão: reaproveita o id — inclusive quando só o
    // caminho da entrada é passado (o painel não sabe da pasta).
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
    // Era o 404 da aba: o render registrava a mesma composição, recebia o id do
    // preview e o liberava no fim. Agora o id vem da pasta + entrada, e quem não
    // criou o registro fica sabendo (created: false) para não liberá-lo.
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
