import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The module registers the composition — and the registry touches `app`/`protocol` (it is from
// the main). The index falls in a temporary folder and no protocol is registered.
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

describe('folder and entry derivation', () => {
  it('a file is the entry and the served folder is the one that contains it', () => {
    const target = path.join('proj', 'edit', 'animations', 'title', 'title.html')
    expect(motionTargetFrom(target, false)).toEqual({
      folder: path.resolve('proj', 'edit', 'animations', 'title'),
      file: path.resolve(target),
      entry: 'title.html',
    })
  })

  it('a folder uses its own index.html', () => {
    const folder = path.join('proj', 'edit', 'animations', 'title')
    expect(motionTargetFrom(folder, true)).toEqual({
      folder: path.resolve(folder),
      file: path.resolve(folder, MOTION_ENTRY_FILE),
      entry: MOTION_ENTRY_FILE,
    })
  })

  it('normalizes the path before deriving (`.` and `..`)', () => {
    const dir = path.join('proj', 'edit', 'animations')
    expect(motionTargetFrom(path.join(dir, 'title', '..', 'title'), true).folder).toBe(path.resolve(dir, 'title'))
    expect(motionTargetFrom(path.join(dir, '..', 'animations', 'title.html'), false).folder).toBe(path.resolve(dir))
  })
})

describe('prepareMotionPreview', () => {
  it('registers the entry of a composition folder', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-preview-'))
    await writeFile(path.join(folder, 'index.html'), '<head></head>')
    const preview = await prepareMotionPreview(folder, { root: os.tmpdir(), sessionId: 's1' })
    expect(preview.entry).toBe(MOTION_ENTRY_FILE)
    expect(preview.folder).toBe(path.resolve(folder))
    expect(preview.url).toBe(`orbit-motion://${preview.id}/${MOTION_ENTRY_FILE}`)
    await rm(folder, { recursive: true, force: true })
  })

  it('refuses a path that does not exist and a folder with no index.html', async () => {
    await expect(prepareMotionPreview(path.join(os.tmpdir(), 'orbit-motion-inexistente'))).rejects.toThrow(/not found/)
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-preview-'))
    await expect(prepareMotionPreview(folder)).rejects.toThrow(new RegExp(MOTION_ENTRY_FILE))
    await rm(folder, { recursive: true, force: true })
  })
})

describe('path outside the allowed folder', () => {
  const ctx = {
    sessionId: 's1',
    directory: path.resolve(os.tmpdir(), 'proj'),
    extraDirectories: [],
    abort: new AbortController().signal,
  }

  it('resolveSafePath accepts what is inside and refuses what escapes', () => {
    expect(resolveSafePath(ctx, 'edit/animations/title/index.html')).toBe(
      path.resolve(ctx.directory, 'edit/animations/title/index.html'),
    )
    expect(() => resolveSafePath(ctx, '../fora/index.html')).toThrow(PathAccessError)
    expect(() => resolveSafePath(ctx, path.resolve(os.tmpdir(), 'fora.html'))).toThrow(PathAccessError)
  })
})
