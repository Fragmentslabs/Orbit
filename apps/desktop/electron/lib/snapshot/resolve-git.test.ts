import { describe, expect, it, vi } from 'vitest'

// The module resolves git at load and touches the Electron app — none of that
// matters here, only the pure resolution function.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { resolveGitBinary } = await import('./index')

/**
 * On Windows the snapshot broke on every turn of code mode: the resolution had
 * been written for macOS and joined PATH with ":", looked for "git" without ".exe" and
 * created a second "PATH" key next to the Windows "Path". The log said
 * "spawn git ENOENT" with git installed and on the PATH.
 */

const fileExists = (files: string[]) => (file: string) => files.includes(file)

describe('resolveGitBinary', () => {
  it('on Windows, it finds git.exe in the Path and does not create a second variable', () => {
    const env = { Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }
    const r = resolveGitBinary('win32', env, fileExists(['C:\\Program Files\\Git\\cmd\\git.exe']))

    expect(r.binary).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    // A single key, with the name it already had — two keys differing only
    // in case leave the child process with the wrong one.
    expect(Object.keys(r.env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path'])
    expect(r.env.Path).toBe('C:\\Windows\\system32;C:\\Program Files\\Git\\cmd')
  })

  it('on Windows, it does not mix macOS directories into the PATH', () => {
    const r = resolveGitBinary('win32', { Path: 'C:\\Windows' }, fileExists([]))
    expect(r.env.Path).toBe('C:\\Windows')
    expect(r.env.Path).not.toContain('/usr/bin')
  })

  it('on Windows, outside the PATH, it finds git where the installer leaves it', () => {
    const r = resolveGitBinary('win32', { Path: 'C:\\Windows' }, fileExists(['C:\\Program Files\\Git\\cmd\\git.exe']))
    expect(r.binary).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
  })

  it('on Windows, it finds the per-user installation', () => {
    const local = 'C:\\Users\\x\\AppData\\Local'
    const r = resolveGitBinary(
      'win32',
      { Path: 'C:\\Windows', LOCALAPPDATA: local },
      fileExists([`${local}\\Programs\\Git\\cmd\\git.exe`]),
    )
    expect(r.binary).toBe(`${local}\\Programs\\Git\\cmd\\git.exe`)
  })

  it('on macOS, the minimal Finder PATH still finds the Homebrew git', () => {
    // The case the resolution was written for, and which has to keep working.
    const r = resolveGitBinary('darwin', { PATH: '/usr/bin' }, fileExists(['/opt/homebrew/bin/git']))
    expect(r.binary).toBe('/opt/homebrew/bin/git')
    expect(r.env.PATH?.split(':')).toContain('/opt/homebrew/bin')
    expect(r.env.PATH?.startsWith('/usr/bin')).toBe(true)
  })

  it('with no git anywhere, it hands over "git" and lets the PATH decide', () => {
    const r = resolveGitBinary('linux', { PATH: '/usr/bin' }, fileExists([]))
    expect(r.binary).toBe('git')
  })
})
