import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkFetchUrl, resolveInsideFolders, safeHeaders } from './guards'

describe('checkFetchUrl', () => {
  it('allows a listed host and its subdomains over https', () => {
    expect(checkFetchUrl('https://api.github.com/x', ['github.com']).ok).toBe(true)
    expect(checkFetchUrl('https://github.com/x', ['github.com']).ok).toBe(true)
  })
  it('refuses http, unlisted hosts and look-alikes', () => {
    expect(checkFetchUrl('http://github.com/x', ['github.com']).ok).toBe(false)
    expect(checkFetchUrl('https://evil.com/x', ['github.com']).ok).toBe(false)
    expect(checkFetchUrl('https://notgithub.com/x', ['github.com']).ok).toBe(false)
    expect(checkFetchUrl('not a url', ['github.com']).ok).toBe(false)
    expect(checkFetchUrl('https://github.com/x', []).ok).toBe(false)
  })
})

describe('safeHeaders', () => {
  it('keeps only harmless headers', () => {
    expect(safeHeaders({ Accept: 'application/json', Cookie: 'a=b', Authorization: 'x' })).toEqual({ Accept: 'application/json' })
  })
})

describe('resolveInsideFolders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-guards-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-outside-'))
  fs.writeFileSync(path.join(root, 'a.csv'), 'x')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))

  it('reads inside the first folder, relative or absolute', () => {
    expect(resolveInsideFolders('a.csv', [root]).ok).toBe(true)
    expect(resolveInsideFolders(path.join(root, 'a.csv'), [root]).ok).toBe(true)
  })
  it('refuses paths that climb out, absolute outsiders and symlinks to outside', () => {
    expect(resolveInsideFolders('../' + path.basename(outside) + '/secret.txt', [root]).ok).toBe(false)
    expect(resolveInsideFolders(path.join(outside, 'secret.txt'), [root]).ok).toBe(false)
    expect(resolveInsideFolders('link.txt', [root]).ok).toBe(false)
  })
  it('refuses everything without folders', () => {
    expect(resolveInsideFolders('a.csv', []).ok).toBe(false)
  })
})
