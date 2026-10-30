import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * S/E/C transition per path — the revert that does not touch the rest of the folder.
 *
 * S = state before the turn, E = state after, C = worktree now. Each case
 * here is an answer to "another conversation touched this file after the turn?".
 */
const userData = path.join(os.tmpdir(), `orbit-transition-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}))

const { capture, diffPaths, transition } = await import('./index')

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-transition-proj-'))
})

afterEach(async () => {
  // The capture gc is fire-and-forget: without waiting, it would still be running
  // when the temp folder was deleted.
  await new Promise((resolve) => setTimeout(resolve, 80))
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), content, 'utf8')
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8')
}

async function exists(rel: string): Promise<boolean> {
  return fs.lstat(path.join(root, rel)).then(
    () => true,
    () => false,
  )
}

describe('transition', () => {
  it('gives a modified file back to the content of the previous turn', async () => {
    await write('a.txt', 'um')
    const start = await capture(root)
    await write('a.txt', 'dois')
    const end = await capture(root)

    const result = await transition(root, end, start)

    expect(result).toEqual({ applied: ['a.txt'], conflicts: [], already: [] })
    expect(await read('a.txt')).toBe('um')
  })

  it('deletes the file created by the turn and gives back what it deleted', async () => {
    await write('apagado.txt', 'volta')
    const start = await capture(root)
    await write('new.txt', 'created')
    await fs.rm(path.join(root, 'apagado.txt'))
    const end = await capture(root)

    const result = await transition(root, end, start)

    expect(result.applied.sort()).toEqual(['apagado.txt', 'new.txt'])
    expect(await exists('new.txt')).toBe(false)
    expect(await read('apagado.txt')).toBe('volta')
  })

  it('does NOT touch the file another conversation changed after the turn', async () => {
    await write('a.txt', 'before')
    const start = await capture(root)
    await write('a.txt', 'turno')
    const end = await capture(root)
    // After the turn, another conversation (or the user outside Orbit) writes.
    await write('a.txt', 'another conversation')

    const result = await transition(root, end, start)

    expect(result.applied).toEqual([])
    expect(result.conflicts).toEqual(['a.txt'])
    expect(await read('a.txt')).toBe('another conversation')
  })

  it('a name with [ ] is a literal path: it does not restore the neighbor the pattern would match', async () => {
    // Next.js dynamic route: by default, `app/[id]/page.tsx` matches
    // `app/i/page.tsx` — which here changed after the turn and is a conflict.
    await write('app/[id]/page.tsx', 'before')
    await write('app/i/page.tsx', 'before')
    const start = await capture(root)
    await write('app/[id]/page.tsx', 'turno')
    await write('app/i/page.tsx', 'turno')
    const end = await capture(root)
    await write('app/i/page.tsx', 'another conversation')

    const result = await transition(root, end, start)

    expect(result.applied).toEqual(['app/[id]/page.tsx'])
    expect(result.conflicts).toEqual(['app/i/page.tsx'])
    expect(await read('app/[id]/page.tsx')).toBe('before')
    expect(await read('app/i/page.tsx')).toBe('another conversation')
  })

  it('a name with a trailing space is the file name, not junk to trim', async () => {
    const start = await capture(root)
    await write('nota ', 'do turno')
    const end = await capture(root)

    const result = await transition(root, end, start)

    expect(result.applied).toEqual(['nota '])
    expect(await exists('nota ')).toBe(false)
  })

  it('deleting the created file takes with it only the folders left empty', async () => {
    await write('src/existente.ts', 'stays')
    const start = await capture(root)
    await write('src/novo/fundo/a.ts', 'do turno')
    await write('src/outro/b.ts', 'do turno')
    const end = await capture(root)
    // Someone put a file in one of the new folders after the turn.
    await write('src/outro/de-fora.ts', 'externo')

    await transition(root, end, start)

    expect(await exists('src/novo')).toBe(false)
    expect(await exists('src/outro/de-fora.ts')).toBe(true)
    expect(await exists('src/existente.ts')).toBe(true)
  })

  it('`paths` limits the transition to the given paths', async () => {
    await write('a.txt', 'before')
    await write('b.txt', 'before')
    const start = await capture(root)
    await write('a.txt', 'turno')
    await write('b.txt', 'turno')
    const end = await capture(root)

    const result = await transition(root, end, start, { paths: ['a.txt'] })

    expect(result.applied).toEqual(['a.txt'])
    expect(await read('a.txt')).toBe('before')
    expect(await read('b.txt')).toBe('turno')
  })

  it('does not delete the file created by the turn that was edited later', async () => {
    const start = await capture(root)
    await write('new.txt', 'do turno')
    const end = await capture(root)
    await write('new.txt', 'edited later')

    const result = await transition(root, end, start)

    expect(result.conflicts).toEqual(['new.txt'])
    expect(await read('new.txt')).toBe('edited later')
  })

  it('a turn with no write touches nothing', async () => {
    await write('a.txt', 'stable')
    const start = await capture(root)
    const end = await capture(root)

    const result = await transition(root, end, start)

    expect(result).toEqual({ applied: [], conflicts: [], already: [] })
    expect(await read('a.txt')).toBe('stable')
  })

  it('a symlink goes back to the previous target (symlink hash, not of the followed file)', async () => {
    await write('um.txt', 'um')
    await write('dois.txt', 'dois')
    await fs.symlink('um.txt', path.join(root, 'link'))
    const start = await capture(root)
    await fs.rm(path.join(root, 'link'))
    await fs.symlink('dois.txt', path.join(root, 'link'))
    const end = await capture(root)

    const result = await transition(root, end, start)

    expect(result.applied).toEqual(['link'])
    expect(await fs.readlink(path.join(root, 'link'))).toBe('um.txt')
  })

  it('skipped paths (manual panel save) become a conflict, preserved', async () => {
    await write('a.txt', 'before')
    await write('manual.txt', 'before')
    const start = await capture(root)
    await write('a.txt', 'turno')
    await write('manual.txt', 'saved by hand')
    const end = await capture(root)

    const result = await transition(root, end, start, { skip: new Set(['manual.txt']) })

    expect(result.applied).toEqual(['a.txt'])
    expect(result.conflicts).toEqual(['manual.txt'])
    expect(await read('a.txt')).toBe('before')
    expect(await read('manual.txt')).toBe('saved by hand')
  })

  it('unrevert: only gives back the path that is still in the state left by the revert', async () => {
    await write('a.txt', 'before')
    const start = await capture(root)
    await write('a.txt', 'turno')
    const end = await capture(root)
    await transition(root, end, start)
    const afterRevert = await capture(root)
    // Someone writes between the revert and the unrevert.
    await write('a.txt', 'novidade')

    const result = await transition(root, afterRevert, end)

    expect(result.conflicts).toEqual(['a.txt'])
    expect(await read('a.txt')).toBe('novidade')
  })

  it('diffPaths shows only the diff of the applied paths', async () => {
    await write('a.txt', 'um')
    await write('b.txt', 'um')
    const start = await capture(root)
    await write('a.txt', 'dois')
    await write('b.txt', 'dois')
    const end = await capture(root)

    const changes = await diffPaths(root, start, end, ['a.txt'])

    expect(changes.files).toEqual(['a.txt'])
    expect(changes.patch).toContain('a/a.txt')
    expect(changes.patch).not.toContain('b/b.txt')
  })
})
