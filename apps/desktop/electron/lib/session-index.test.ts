import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'

const disk = vi.hoisted(() => {
  const files = new Map<string, { value: unknown; mtimeMs: number }>()
  return { files, reads: [] as string[], clock: { t: 1 } }
})

vi.mock('./storage', () => ({
  listKeys: async (prefix: string) => [...disk.files.keys()].filter((k) => k.startsWith(prefix)),
  readJson: async (key: string) => {
    disk.reads.push(key)
    const f = disk.files.get(key)
    return f ? structuredClone(f.value) : null
  },
  statKey: async (key: string) => {
    const f = disk.files.get(key)
    return f ? { mtimeMs: f.mtimeMs, size: JSON.stringify(f.value).length } : null
  },
}))

const { SessionIndex, excerpt, splitPassages } = await import('./session-index')

const NOW = Date.UTC(2026, 9, 30)

function put(key: string, value: unknown) {
  disk.files.set(key, { value, mtimeMs: ++disk.clock.t })
}

function chat(id: string, over: Partial<SessionInfo> = {}, messages: Array<[string, string, Partial<ChatMessage>?]> = []) {
  put(`session/${id}`, {
    id,
    title: `Chat ${id}`,
    mode: 'chat',
    pinned: false,
    archived: false,
    folderId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } satisfies SessionInfo)
  put(
    `messages/${id}`,
    messages.map(([role, text, extra], i) => ({
      id: `${id}-m${i}`,
      role,
      createdAt: NOW + i,
      parts: [{ id: `p${i}`, type: 'text', text, state: 'done' }],
      ...extra,
    })),
  )
}

const ask = (index: InstanceType<typeof SessionIndex>, query: string, extra = {}) =>
  index.search({ query, waitMs: 5000, ...extra })

beforeEach(() => {
  disk.files.clear()
  disk.reads.length = 0
})

describe('SessionIndex — what matches', () => {
  it('ignores accents in both directions', async () => {
    chat('a', {}, [['user', 'A decisão sobre a configuração do cache ficou para amanhã']])
    chat('b', {}, [['assistant', 'Cafe da manha: resolvemos a Acao de deploy']])
    const index = new SessionIndex(() => NOW)
    expect((await ask(index, 'decisao configuracao')).matches.map((m) => m.chat.id)).toEqual(['a'])
    expect((await ask(index, 'café ação')).matches.map((m) => m.chat.id)).toEqual(['b'])
  })

  it('finds a word by its prefix and by whole variants', async () => {
    chat('a', {}, [['user', 'Instalei o LaunchAgent para subir o app no login']])
    chat('b', {}, [['assistant', 'Os LaunchAgents ficam em ~/Library/LaunchAgents']])
    chat('c', {}, [['user', 'Nada a ver com isso']])
    const index = new SessionIndex(() => NOW)
    const ids = (await ask(index, 'launchagent')).matches.map((m) => m.chat.id).sort()
    expect(ids).toEqual(['a', 'b'])
    // A fragment typed so far, as in the search box
    expect((await ask(index, 'launchag')).matches).toHaveLength(2)
    // Too short to expand: stays exact
    expect((await ask(index, 'la')).matches).toHaveLength(0)
  })

  it('indexes only what was said: no tool output, reasoning or attachment text', async () => {
    chat('a', {}, [['assistant', 'resposta normal']])
    put('messages/a', [
      {
        id: 'm1',
        role: 'assistant',
        createdAt: NOW,
        parts: [
          { id: '1', type: 'text', text: 'resposta normal', state: 'done' },
          { id: '2', type: 'reasoning', text: 'pensando em zebra', state: 'done' },
          { id: '3', type: 'tool', tool: 'bash', state: 'done', output: 'zebra no stdout' },
          { id: '4', type: 'text', text: 'zebra extraída do PDF', state: 'done', source: 'attachment' },
        ],
      },
    ])
    const index = new SessionIndex(() => NOW)
    expect((await ask(index, 'zebra')).matches).toHaveLength(0)
    expect((await ask(index, 'resposta')).matches).toHaveLength(1)
  })

  it('leaves out workers and routine runs; archived only on request', async () => {
    chat('user', {}, [['user', 'tema do projeto: quasar']])
    chat('worker', { parentId: 'user' }, [['assistant', 'quasar do worker']])
    chat('routine', { routineId: 'r1' }, [['assistant', 'quasar da rotina']])
    chat('old', { archived: true }, [['user', 'quasar arquivado']])
    const index = new SessionIndex(() => NOW)
    expect((await ask(index, 'quasar')).matches.map((m) => m.chat.id)).toEqual(['user'])
    expect((await ask(index, 'quasar', { includeArchived: true })).matches.map((m) => m.chat.id).sort()).toEqual([
      'old',
      'user',
    ])
  })

  it('never returns an excluded chat (the current one)', async () => {
    chat('now', {}, [['user', 'falamos de nebulosa']])
    chat('before', {}, [['user', 'ontem também: nebulosa']])
    const index = new SessionIndex(() => NOW)
    const res = await ask(index, 'nebulosa', { excludeSessionIds: ['now'] })
    expect(res.matches.map((m) => m.chat.id)).toEqual(['before'])
  })

  it('has no ceiling on how many chats answer', async () => {
    for (let i = 0; i < 90; i++) chat(`s${i}`, { updatedAt: NOW - i * 1000 }, [['user', `pergunta ${i} sobre pulsar`]])
    const res = await ask(new SessionIndex(() => NOW), 'pulsar')
    expect(res.chats).toBe(90)
    expect(res.matches).toHaveLength(90)
    expect(res.status).toMatchObject({ indexed: 90, total: 90, complete: true })
  })

  it('matches the title and drops it when only one side of the conversation is wanted', async () => {
    chat('a', { title: 'Rotina de backup' }, [['user', 'oi']])
    const index = new SessionIndex(() => NOW)
    const byTitle = await ask(index, 'backup')
    expect(byTitle.matches[0].passage.role).toBe('title')
    expect((await ask(index, 'backup', { titles: false })).matches).toHaveLength(0)
    expect((await ask(index, 'backup', { role: 'user' })).matches).toHaveLength(0)
  })

  it('filters by role and date', async () => {
    chat('a', {}, [
      ['user', 'primeira menção de cometa', {}],
      ['assistant', 'segunda menção de cometa', { createdAt: NOW + 5 * 86_400_000 }],
    ])
    const index = new SessionIndex(() => NOW)
    expect((await ask(index, 'cometa', { role: 'assistant' })).matches.map((m) => m.passage.role)).toEqual(['assistant'])
    expect((await ask(index, 'cometa', { after: NOW + 86_400_000 })).matches).toHaveLength(1)
    expect((await ask(index, 'cometa', { before: NOW + 86_400_000 })).matches).toHaveLength(1)
  })

  it('ranks a compaction summary below the message that says the same', async () => {
    chat('a', {}, [
      ['user', 'o gargalo era o disco', { summary: true }],
      ['assistant', 'o gargalo era o disco'],
    ])
    const res = await ask(new SessionIndex(() => NOW), 'gargalo disco')
    expect(res.matches.map((m) => m.passage.messageId)).toEqual(['a-m1', 'a-m0'])
  })

  it('keeps one passage per message even when its text was cut in several', async () => {
    chat('a', {}, [['assistant', `${'palavra comum '.repeat(120)} fim com tucano`]])
    const res = await ask(new SessionIndex(() => NOW), 'tucano palavra')
    expect(res.matches).toHaveLength(1)
  })
})

describe('SessionIndex — keeping up with the disk', () => {
  it('reads again only the chat whose file changed', async () => {
    chat('a', {}, [['user', 'assunto antigo: ametista']])
    chat('b', {}, [['user', 'outro assunto']])
    const index = new SessionIndex(() => NOW)
    await ask(index, 'ametista')
    disk.reads.length = 0

    expect((await ask(index, 'ametista')).matches).toHaveLength(1)
    expect(disk.reads).toEqual([])

    chat('b', {}, [['user', 'agora também ametista']])
    disk.reads.length = 0
    expect((await ask(index, 'ametista')).matches).toHaveLength(2)
    expect(disk.reads.sort()).toEqual(['messages/b', 'session/b'])
  })

  it('picks up a chat that was archived or deleted', async () => {
    chat('a', {}, [['user', 'tema rubi']])
    const index = new SessionIndex(() => NOW)
    expect((await ask(index, 'rubi')).matches).toHaveLength(1)
    put('session/a', { ...(disk.files.get('session/a')!.value as SessionInfo), archived: true })
    expect((await ask(index, 'rubi')).matches).toHaveLength(0)
    disk.files.delete('session/a')
    disk.files.delete('messages/a')
    expect((await ask(index, 'rubi', { includeArchived: true })).matches).toHaveLength(0)
    expect(index.status().total).toBe(0)
  })

  it('does not reread the chat being written when it is skipped', async () => {
    chat('a', {}, [['user', 'tema opala']])
    const index = new SessionIndex(() => NOW)
    await ask(index, 'opala')
    chat('a', {}, [['user', 'tema opala e jade']])
    disk.reads.length = 0
    await ask(index, 'opala', { excludeSessionIds: ['a'] })
    expect(disk.reads).not.toContain('messages/a')
  })

  it('answers with what exists, and says so, when searched before the first build ends', async () => {
    for (let i = 0; i < 5; i++) chat(`s${i}`, {}, [['user', 'tema ônix']])
    const index = new SessionIndex(() => NOW)
    const early = await index.search({ query: 'onix', waitMs: 0 })
    expect(early.status.complete).toBe(false)
    expect(early.status.indexed).toBeLessThan(early.status.total || 1)

    await index.start()
    const late = await index.search({ query: 'onix', waitMs: 0 })
    expect(late.matches).toHaveLength(5)
    expect(late.status).toEqual({ indexed: 5, total: 5, complete: true })
  })
})

describe('splitPassages', () => {
  it('keeps a short text whole and cuts a long one with overlap', () => {
    expect(splitPassages('  curto  ')).toEqual(['curto'])
    expect(splitPassages('   ')).toEqual([])
    const long = Array.from({ length: 400 }, (_, i) => `palavra${i}`).join(' ')
    const parts = splitPassages(long)
    expect(parts.length).toBeGreaterThan(5)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(600)
    // Consecutive passages share a stretch, so a sentence on the seam is in one of them
    for (let i = 1; i < parts.length; i++) {
      const tail = parts[i - 1].split(' ').slice(-3)
      expect(tail.some((w) => parts[i].includes(w))).toBe(true)
    }
    // Nothing is lost
    for (let i = 0; i < 400; i += 37) expect(parts.some((p) => p.includes(`palavra${i} `) || p.endsWith(`palavra${i}`))).toBe(true)
  })
})

describe('excerpt', () => {
  const text = `${'abc '.repeat(80)}a Configuração do cache mudou ${'xyz '.repeat(80)}`

  it('centres on the first term, accent-insensitive, with ellipses where it cut', () => {
    const out = excerpt(text, ['configuracao'], 100)
    expect(out).toContain('Configuração')
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(104)
  })

  it('returns a short text untouched and the start when no term is found', () => {
    expect(excerpt('curto  e\nsimples', ['x'], 100)).toBe('curto e simples')
    expect(excerpt(text, ['inexistente'], 50).startsWith('abc')).toBe(true)
  })
})
