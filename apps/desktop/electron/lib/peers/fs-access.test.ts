import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanRelative, FsAccessError, listDirectory, readProjectFile } from './fs-access'

describe('peer file access', () => {
  let base: string
  let project: string
  let outside: string

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-peer-fs-'))
    project = path.join(base, 'project')
    outside = path.join(base, 'outside')
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.mkdirSync(path.join(project, '.git'), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'export const x = 1\n')
    fs.writeFileSync(path.join(project, '.env'), 'SECRET=1')
    fs.writeFileSync(path.join(project, 'server.key'), 'k')
    fs.writeFileSync(path.join(project, '.git', 'config'), '[core]')
    fs.writeFileSync(path.join(outside, 'private.txt'), 'nope')
    fs.writeFileSync(path.join(project, 'bin.dat'), Buffer.from([1, 0, 2, 3]))
    fs.symlinkSync(outside, path.join(project, 'escape'))
    fs.symlinkSync(path.join(project, '.env'), path.join(project, 'innocent.txt'))
  })

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('rejects traversal, absolute paths and secrets by name', () => {
    expect(() => cleanRelative('../outside')).toThrow(FsAccessError)
    expect(() => cleanRelative('src/../../x')).toThrow(FsAccessError)
    expect(() => cleanRelative('/etc/passwd')).toThrow(FsAccessError)
    expect(() => cleanRelative('C:\\Windows')).toThrow(FsAccessError)
    expect(() => cleanRelative('.git/config')).toThrow(FsAccessError)
    expect(() => cleanRelative('a\0b')).toThrow(FsAccessError)
    expect(cleanRelative('src//./app.ts')).toBe('src/app.ts')
  })

  it('lists without the secrets', async () => {
    const tree = await listDirectory([project], 0, '')
    const names = tree.entries.map((e) => e.name)
    expect(names).toContain('src')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('.git')
    expect(names).not.toContain('server.key')
    expect(tree.entries[0].dir).toBe(true)
  })

  it('reads a project file', async () => {
    const file = await readProjectFile([project], 0, 'src/app.ts')
    expect(file.encoding).toBe('utf8')
    expect(file.content).toContain('export const x')
  })

  it('a symlink cannot leave the project nor reach a secret', async () => {
    await expect(readProjectFile([project], 0, 'escape/private.txt')).rejects.toThrow(FsAccessError)
    await expect(listDirectory([project], 0, 'escape')).rejects.toThrow(FsAccessError)
    await expect(readProjectFile([project], 0, 'innocent.txt')).rejects.toThrow(FsAccessError)
  })

  it('an unknown root index is not found', async () => {
    await expect(listDirectory([project], 3, '')).rejects.toThrow(FsAccessError)
  })

  it('binary files come back empty', async () => {
    const file = await readProjectFile([project], 0, 'bin.dat')
    expect(file.content).toBe('')
    expect(file.truncated).toBe(true)
  })
})
