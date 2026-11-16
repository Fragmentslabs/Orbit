import { describe, expect, it } from 'vitest'
import { chatsInFolder, collectKnownFolders, normalizePath } from './known-folders'

describe('normalizePath', () => {
  it('drops trailing separators but keeps roots', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('C:\\')).toBe('C:\\')
    expect(normalizePath('C:\\proj\\')).toBe('C:\\proj')
  })
})

describe('collectKnownFolders', () => {
  const sessions = [
    { directory: '/w/app', updatedAt: 10 },
    { directory: '/w/app/', updatedAt: 30 },
    { directory: '/w/lib', updatedAt: 20 },
    { directory: '/w/routine', updatedAt: 99, routineId: 'r1' },
    { updatedAt: 50 },
  ]

  it('merges chats per folder, newest first, ignoring routines and chats with no folder', () => {
    const out = collectKnownFolders({ sessions })
    expect(out.map((f) => [f.path, f.chatCount])).toEqual([
      ['/w/app', 2],
      ['/w/lib', 1],
    ])
  })

  it('adds project folders and recents without chats, recents first among the untouched', () => {
    const out = collectKnownFolders({
      sessions: [],
      projectFolders: ['/p/zeta'],
      recents: ['/p/alpha', '/p/zeta'],
    })
    expect(out.map((f) => f.path)).toEqual(['/p/alpha', '/p/zeta'])
  })

  it('hides removed folders and applies aliases', () => {
    const out = collectKnownFolders({ sessions, hidden: ['/w/lib/'], aliases: { '/w/app': 'My App' } })
    expect(out.map((f) => f.name)).toEqual(['My App'])
  })
})

describe('chatsInFolder', () => {
  it('lists only the chats of that main folder, newest first', () => {
    const list = [
      { id: 'a', directory: '/w/app', updatedAt: 1 },
      { id: 'b', directory: '/w/app/', updatedAt: 3 },
      { id: 'c', directory: '/w/other', updatedAt: 9 },
      { id: 'd', directory: '/w/app', updatedAt: 5, routineId: 'r' },
    ]
    expect(chatsInFolder(list, '/w/app').map((s) => s.id)).toEqual(['b', 'a'])
  })
})
