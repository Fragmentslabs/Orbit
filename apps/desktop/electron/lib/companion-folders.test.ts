import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  FolderRequestError,
  folderCreateRemote,
  folderGitInfo,
  folderInitStatus,
  safeDirectory,
  type FolderDeps,
} from './companion-folders'

const root = mkdtempSync(join(tmpdir(), 'orbit-folders-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function sh(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function makeRepo(name: string, commit: boolean): string {
  const dir = join(root, name)
  mkdirSync(dir)
  sh(dir, 'init', '-q')
  if (commit) {
    writeFileSync(join(dir, 'a.txt'), 'a')
    sh(dir, 'add', '-A')
    sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  }
  return dir
}

function deps(over: Partial<FolderDeps> = {}): FolderDeps {
  return {
    initStatus: async (directory) => ({ directory, initialized: false, running: false }),
    createRemoteRepo: async () => ({ ok: true, url: 'https://github.com/o/r', fullName: 'o/r', pushed: true }),
    ...over,
  }
}

describe('safeDirectory', () => {
  it('rejects relative, empty, NUL and non-string paths', () => {
    for (const bad of ['', 'relative/dir', '../x', 'a\0b', 42, undefined]) {
      expect(() => safeDirectory(bad)).toThrow(FolderRequestError)
    }
  })

  it('normalizes dot segments of an absolute path', () => {
    expect(safeDirectory('/a/b/../c')).toBe('/a/c')
  })
})

describe('folderGitInfo', () => {
  it('reports a missing folder without throwing', async () => {
    const info = await folderGitInfo(join(root, 'nope'))
    expect(info.exists).toBe(false)
    expect(info.isRepo).toBe(false)
  })

  it('a plain folder is not a repo', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir)
    const info = await folderGitInfo(dir)
    expect(info).toMatchObject({ exists: true, isRepo: false, hasCommits: false, remoteUrl: null })
  })

  it('a fresh repo has no commits and no remote', async () => {
    const info = await folderGitInfo(makeRepo('fresh', false))
    expect(info).toMatchObject({ isRepo: true, hasCommits: false, remoteUrl: null })
  })

  it('reads commits and the origin url', async () => {
    const dir = makeRepo('full', true)
    sh(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
    const info = await folderGitInfo(dir)
    expect(info).toMatchObject({ isRepo: true, hasCommits: true, remoteUrl: 'https://github.com/o/r.git' })
    expect(info.branch).not.toBe('')
  })
})

describe('folderInitStatus', () => {
  it('delegates to the injected status for an existing folder', async () => {
    const initStatus = vi.fn(async (directory: string) => ({ directory, initialized: true, running: false }))
    const res = await folderInitStatus(root, deps({ initStatus }))
    expect(res.initialized).toBe(true)
    expect(initStatus).toHaveBeenCalledWith(root)
  })

  it('refuses a folder that does not exist', async () => {
    await expect(folderInitStatus(join(root, 'ghost'), deps())).rejects.toThrow(FolderRequestError)
  })
})

describe('folderCreateRemote', () => {
  it('creates the repo for a local repo without remote', async () => {
    const dir = makeRepo('norem', true)
    const createRemoteRepo = vi.fn(deps().createRemoteRepo)
    const res = await folderCreateRemote({ type: 'folders:create-remote', directory: dir, name: 'r', isPrivate: true }, deps({ createRemoteRepo }))
    expect(res.ok).toBe(true)
    expect(createRemoteRepo).toHaveBeenCalledWith(dir, 'r', true)
  })

  it('refuses a folder that is not a repo or already has a remote', async () => {
    const plain = join(root, 'plain')
    const req = { type: 'folders:create-remote' as const, name: 'r', isPrivate: true }
    await expect(folderCreateRemote({ ...req, directory: plain }, deps())).rejects.toThrow(/not a git/)
    const withRemote = makeRepo('hasrem', true)
    sh(withRemote, 'remote', 'add', 'origin', 'https://github.com/o/x.git')
    await expect(folderCreateRemote({ ...req, directory: withRemote }, deps())).rejects.toThrow(/already has a remote/)
  })

  it('drops the raw credential detail before it reaches the phone', async () => {
    const dir = makeRepo('nocred', true)
    const res = await folderCreateRemote(
      { type: 'folders:create-remote', directory: dir, name: 'r', isPrivate: false },
      deps({
        createRemoteRepo: async () => ({ ok: false, kind: 'noCredential', hint: 'ghMissing', detail: { git: { output: 'secret' } } }),
      }),
    )
    expect(res).toEqual({ ok: false, kind: 'noCredential', hint: 'ghMissing' })
  })
})
