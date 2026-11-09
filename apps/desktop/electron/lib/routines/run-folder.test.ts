import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunFolder, runFolderName, runFolderPath } from './run-folder'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fsp.rm(r, { recursive: true, force: true })))
})

describe('run folder', () => {
  const when = new Date(2026, 10, 8, 14, 5, 9).getTime()

  it('names the folder by the local time of the run', () => {
    expect(runFolderName(when)).toBe('2026-11-08_14-05-09')
  })

  it('keeps a hostile routine id inside the root', () => {
    const p = runFolderPath('/data/runs', '../../etc', when)
    expect(p.startsWith(path.join('/data/runs', ''))).toBe(true)
    expect(path.relative('/data/runs', p).startsWith('..')).toBe(false)
  })

  it('creates the folder, and a numbered one when the second is taken', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'run-folder-'))
    roots.push(root)
    const first = await createRunFolder(root, 'r1', when)
    const second = await createRunFolder(root, 'r1', when)
    expect(first).not.toBe(second)
    expect((await fsp.stat(first)).isDirectory()).toBe(true)
    expect(path.basename(second)).toBe('2026-11-08_14-05-09-2')
  })
})
