import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// O módulo registra a composição — e o registro toca `app`/`protocol` (é do
// main). O índice cai numa pasta temporária e nenhum protocolo é registrado.
vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-motion-preview-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => [] },
    protocol: { handle: () => {} },
  }
})

const { MOTION_ENTRY_FILE, motionTargetFrom, prepareMotionPreview } = await import('./motion-preview')
const { PathAccessError, resolveSafePath } = await import('../tools/context')

const tempRoot = path.join(os.tmpdir(), `orbit-motion-preview-test-${process.pid}`)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('derivação da pasta e da entrada', () => {
  it('um arquivo é a entrada e a pasta servida é a que o contém', () => {
    const target = path.join('proj', 'edit', 'animations', 'title', 'title.html')
    expect(motionTargetFrom(target, false)).toEqual({
      folder: path.resolve('proj', 'edit', 'animations', 'title'),
      file: path.resolve(target),
      entry: 'title.html',
    })
  })

  it('uma pasta usa o index.html dela', () => {
    const folder = path.join('proj', 'edit', 'animations', 'title')
    expect(motionTargetFrom(folder, true)).toEqual({
      folder: path.resolve(folder),
      file: path.resolve(folder, MOTION_ENTRY_FILE),
      entry: MOTION_ENTRY_FILE,
    })
  })

  it('normaliza o caminho antes de derivar (`.` e `..`)', () => {
    const dir = path.join('proj', 'edit', 'animations')
    expect(motionTargetFrom(path.join(dir, 'title', '..', 'title'), true).folder).toBe(path.resolve(dir, 'title'))
    expect(motionTargetFrom(path.join(dir, '..', 'animations', 'title.html'), false).folder).toBe(path.resolve(dir))
  })
})

describe('prepareMotionPreview', () => {
  it('registra a entrada de uma pasta de composição', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-preview-'))
    await writeFile(path.join(folder, 'index.html'), '<head></head>')
    const preview = await prepareMotionPreview(folder, { root: os.tmpdir(), sessionId: 's1' })
    expect(preview.entry).toBe(MOTION_ENTRY_FILE)
    expect(preview.folder).toBe(path.resolve(folder))
    expect(preview.url).toBe(`orbit-motion://${preview.id}/${MOTION_ENTRY_FILE}`)
    await rm(folder, { recursive: true, force: true })
  })

  it('recusa um caminho que não existe e uma pasta sem index.html', async () => {
    await expect(prepareMotionPreview(path.join(os.tmpdir(), 'orbit-motion-inexistente'))).rejects.toThrow(/not found/)
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-preview-'))
    await expect(prepareMotionPreview(folder)).rejects.toThrow(new RegExp(MOTION_ENTRY_FILE))
    await rm(folder, { recursive: true, force: true })
  })
})

describe('caminho fora da pasta permitida', () => {
  const ctx = {
    sessionId: 's1',
    directory: path.resolve(os.tmpdir(), 'proj'),
    extraDirectories: [],
    abort: new AbortController().signal,
  }

  it('resolveSafePath aceita o que está dentro e recusa o que escapa', () => {
    expect(resolveSafePath(ctx, 'edit/animations/title/index.html')).toBe(
      path.resolve(ctx.directory, 'edit/animations/title/index.html'),
    )
    expect(() => resolveSafePath(ctx, '../fora/index.html')).toThrow(PathAccessError)
    expect(() => resolveSafePath(ctx, path.resolve(os.tmpdir(), 'fora.html'))).toThrow(PathAccessError)
  })
})
