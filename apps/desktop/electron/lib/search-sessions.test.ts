import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ files: new Map<string, { value: unknown; mtimeMs: number }>(), clock: { t: 1 } }))

vi.mock('./storage', () => ({
  listKeys: async (prefix: string) => [...disk.files.keys()].filter((k) => k.startsWith(prefix)),
  readJson: async (key: string) => {
    const f = disk.files.get(key)
    return f ? structuredClone(f.value) : null
  },
  statKey: async (key: string) => {
    const f = disk.files.get(key)
    return f ? { mtimeMs: f.mtimeMs, size: JSON.stringify(f.value).length } : null
  },
}))

const { searchSessions } = await import('./search-sessions')

function chat(id: string, updatedAt: number, texts: string[], over: Record<string, unknown> = {}) {
  disk.files.set(`session/${id}`, {
    mtimeMs: ++disk.clock.t,
    value: { id, title: `Conversa ${id}`, mode: 'chat', pinned: false, archived: false, folderId: null, createdAt: 1, updatedAt, ...over },
  })
  disk.files.set(`messages/${id}`, {
    mtimeMs: ++disk.clock.t,
    value: texts.map((text, i) => ({ id: `${id}-${i}`, role: 'user', createdAt: updatedAt, parts: [{ id: 'p', type: 'text', text, state: 'done' }] })),
  })
}

beforeEach(() => disk.files.clear())

describe('searchSessions', () => {
  it('has no ceiling on how many sessions it covers: the oldest one is found too', async () => {
    for (let i = 0; i < 60; i++) chat(`s${i}`, 1_000_000 - i, [i === 59 ? 'o LaunchAgent do login' : 'nada aqui'])
    const hits = await searchSessions('launchagent')
    expect(hits.map((h) => h.sessionId)).toEqual(['s59'])
  })

  it('keeps the SearchHit contract: ids, title, mode, date and a short excerpt around the term', async () => {
    chat('a', 5000, [`${'preâmbulo '.repeat(40)}a decisão sobre o cache foi adiada ${'epílogo '.repeat(40)}`], { mode: 'code', archived: true })
    const [hit] = await searchSessions('decisao')
    expect(hit).toMatchObject({ sessionId: 'a', sessionTitle: 'Conversa a', mode: 'code', updatedAt: 5000 })
    expect(hit.snippet).toContain('decisão')
    expect(hit.snippet.length).toBeLessThan(140)
    expect(hit.snippet.startsWith('…') && hit.snippet.endsWith('…')).toBe(true)
  })

  it('matches the title, caps the excerpts per session, and ignores blank queries and workers', async () => {
    chat('t', 1, ['x'], { title: 'Plano de backup' })
    chat('many', 2, Array.from({ length: 9 }, (_, i) => `ocorrência ${i} de lagosta`))
    chat('w', 3, ['lagosta do worker'], { parentId: 'many' })
    expect((await searchSessions('backup')).map((h) => h.snippet)).toEqual(['Plano de backup'])
    const lagosta = await searchSessions('lagosta')
    expect(lagosta).toHaveLength(5)
    expect(new Set(lagosta.map((h) => h.sessionId))).toEqual(new Set(['many']))
    expect(await searchSessions('   ')).toEqual([])
  })
})
