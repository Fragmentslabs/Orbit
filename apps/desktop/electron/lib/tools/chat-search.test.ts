import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'

const disk = vi.hoisted(() => ({ files: new Map<string, { value: unknown; mtimeMs: number }>(), clock: { t: 1 } }))

vi.mock('../storage', () => ({
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

const { createChatSearchTools } = await import('./chat-search')

const NOW = Date.UTC(2026, 9, 30, 15)

function put(key: string, value: unknown) {
  disk.files.set(key, { value, mtimeMs: ++disk.clock.t })
}

type Line = [role: 'user' | 'assistant', text: string, extra?: Partial<ChatMessage> & { tools?: string[] }]

function chat(id: string, over: Partial<SessionInfo>, lines: Line[]) {
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
    lines.map(([role, text, extra], i) => ({
      id: `${id}-m${i}`,
      role,
      createdAt: NOW + i * 60_000,
      parts: [
        { id: `t${i}`, type: 'text', text, state: 'done' },
        ...(extra?.tools ?? []).map((tool) => ({ id: `${tool}${i}`, type: 'tool', tool, state: 'done', output: 'SECRET OUTPUT' })),
      ],
      ...(extra ? { ...extra, tools: undefined } : {}),
    })),
  )
}

type Input = Parameters<typeof createChatSearchTools>[0]
const run = async (input: Input, name: 'chat_search' | 'chat_read', args: Record<string, unknown>) => {
  const tools = createChatSearchTools(input) as Record<string, { execute: (a: unknown, o: unknown) => Promise<string> }>
  return tools[name].execute(args, {})
}

const inChat: Input = { sessionId: 'current', mode: 'chat' }
const inCode: Input = { sessionId: 'current', mode: 'code', directory: '/work/orbit' }

beforeEach(() => {
  disk.files.clear()
  chat('current', {}, [['user', 'estamos falando de zênite agora']])
})

describe('chat_search', () => {
  it('reports passages, chats and how complete the index was', async () => {
    chat('a', { title: 'Cache' }, [
      ['user', 'qual a decisão sobre o cache?'],
      ['assistant', 'Decidimos usar cache em memória'],
    ])
    chat('b', {}, [['user', 'outra decisão do cache']])
    const out = await run(inChat, 'chat_search', { query: 'decisao cache', limit: 2 })
    const [header, ...rest] = out.split('\n')
    expect(header).toMatch(/^2 of 3 passages across 2 chats \(indexed \d+\/\d+\)/)
    expect(header).not.toContain('STILL BUILDING')
    // One line per passage with id, mode, date, title, role and message id, then the excerpt
    expect(rest).toHaveLength(4)
    expect(rest[0]).toMatch(/^#\S+ \[chat\] 2026-10-\d\d "(?:Chat b|Cache)" · (user|assistant) · msg \S+$/)
    expect(rest[1].startsWith('  ')).toBe(true)
  })

  it('never answers with the conversation that is calling', async () => {
    chat('a', {}, [['user', 'zênite também aqui']])
    const out = await run(inChat, 'chat_search', { query: 'zenite' })
    expect(out).toContain('#a ')
    expect(out).not.toContain('#current')
  })

  it('in chat, searches chats only; "all" brings the code ones in', async () => {
    chat('c1', {}, [['user', 'falamos de tangerina']])
    chat('k1', { mode: 'code', directory: '/work/orbit' }, [['user', 'código com tangerina']])
    expect(await run(inChat, 'chat_search', { query: 'tangerina' })).toMatch(/^1 of 1 passages across 1 chats/)
    expect(await run(inChat, 'chat_search', { query: 'tangerina', scope: 'all' })).toMatch(/^2 of 2 passages across 2 chats/)
  })

  it('in code, defaults to the chats of the same project', async () => {
    chat('same', { mode: 'code', directory: '/work/orbit' }, [['user', 'migração do banco, passo um']])
    chat('other', { mode: 'code', directory: '/work/blog' }, [['user', 'migração do banco do blog']])
    chat('plain', {}, [['user', 'migração de casa']])
    const out = await run(inCode, 'chat_search', { query: 'migracao' })
    expect(out).toMatch(/^1 of 1 passages across 1 chats/)
    expect(out).toContain('#same ')
    const all = await run(inCode, 'chat_search', { query: 'migracao', scope: 'all' })
    expect(all).toMatch(/^3 of 3 passages across 3 chats/)
  })

  it('in code, a chat of the same sidebar folder counts as the same project', async () => {
    put('session/current', { ...(disk.files.get('session/current')!.value as SessionInfo), mode: 'code', folderId: 'f1', directory: '/work/orbit-wt' })
    chat('sibling', { mode: 'code', folderId: 'f1', directory: '/work/orbit' }, [['user', 'plano de lançamento']])
    const out = await run({ ...inCode, directory: '/work/orbit-wt' }, 'chat_search', { query: 'lancamento', scope: 'folder' })
    expect(out).toContain('#sibling ')
  })

  it('scope "folder" in chat needs a folder', async () => {
    expect(await run(inChat, 'chat_search', { query: 'x', scope: 'folder' })).toContain('not inside a folder')
  })

  it('filters by role and date, and refuses a bad date', async () => {
    chat('a', {}, [
      ['user', 'pergunta sobre jacarandá'],
      ['assistant', 'resposta sobre jacarandá', { createdAt: NOW + 10 * 86_400_000 }],
    ])
    expect(await run(inChat, 'chat_search', { query: 'jacaranda', role: 'assistant' })).toMatch(/^1 of 1/)
    expect(await run(inChat, 'chat_search', { query: 'jacaranda', after: '2026-11-01' })).toMatch(/^1 of 1/)
    expect(await run(inChat, 'chat_search', { query: 'jacaranda', before: '2026-10-01' })).toMatch(/^0 of 0/)
    expect(await run(inChat, 'chat_search', { query: 'jacaranda', after: 'ontem' })).toContain('YYYY-MM-DD')
  })

  it('keeps archived chats by default and can leave them out', async () => {
    chat('old', { archived: true }, [['user', 'assunto antigo: obsidiana']])
    expect(await run(inChat, 'chat_search', { query: 'obsidiana' })).toContain('archived')
    expect(await run(inChat, 'chat_search', { query: 'obsidiana', includeArchived: false })).toMatch(/^0 of 0/)
  })

  it('suggests how to widen when nothing matches', async () => {
    const out = await run(inChat, 'chat_search', { query: 'inexistente' })
    expect(out).toMatch(/^0 of 0 passages across 0 chats/)
    expect(out).toContain('scope "all"')
  })

  it('does not return tool output or reasoning', async () => {
    chat('a', {}, [['assistant', 'rodei o comando', { tools: ['bash'] }]])
    expect(await run(inChat, 'chat_search', { query: 'secret output' })).toMatch(/^0 of 0/)
  })
})

describe('chat_read', () => {
  const long = Array.from({ length: 8 }, (_, i): Line => [i % 2 ? 'assistant' : 'user', `mensagem número ${i}`])

  it('reads the window around a message: 2 before and 2 after by default', async () => {
    chat('a', { title: 'Tema' }, long)
    const out = await run(inChat, 'chat_read', { id: 'a', around: 'a-m4' })
    expect(out).toContain('"Tema" · messages 3–7 of 8')
    for (const i of [2, 3, 4, 5, 6]) expect(out).toContain(`mensagem número ${i}`)
    expect(out).not.toContain('mensagem número 1')
    expect(out).not.toContain('mensagem número 7')
    expect(out).toContain('--- assistant')
    expect(out).toMatch(/later messages not shown\. Call again with around="a-m6"/)
  })

  it('honours before/after and shows tool names but never their output', async () => {
    chat('a', {}, [
      ['user', 'faça'],
      ['assistant', 'feito', { tools: ['bash', 'bash', 'edit'] }],
      ['user', 'ok'],
    ])
    const out = await run(inChat, 'chat_read', { id: 'a', around: 'a-m1', before: 0, after: 0 })
    expect(out).toContain('· tools: bash, edit')
    expect(out).toContain('feito')
    expect(out).not.toContain('faça')
    expect(out).not.toContain('SECRET OUTPUT')
  })

  it('without "around" opens the start, and never the whole chat', async () => {
    chat('a', {}, long)
    const out = await run(inChat, 'chat_read', { id: 'a' })
    expect(out).toContain('messages 1–5 of 8')
    expect(out).not.toContain('mensagem número 5')
  })

  it('stops at maxChars and says how many messages were left out', async () => {
    const big = 'palavra '.repeat(400) // 3200 chars each
    chat('a', {}, [
      ['user', `primeira ${big}`],
      ['assistant', `segunda ${big}`],
      ['user', `terceira ${big}`],
      ['assistant', `quarta ${big}`],
    ])
    const out = await run(inChat, 'chat_read', { id: 'a', before: 3, after: 3, maxChars: 1000 })
    expect(out.length).toBeLessThan(1000 + 700)
    expect(out).toContain('primeira')
    expect(out).toContain('… [cut]')
    expect(out).toMatch(/truncated: 3 more messages \(the last one is cut\)/)
    expect(out).not.toContain('terceira')
  })

  it('counts whole messages left out when the budget ends between messages', async () => {
    chat('a', {}, [
      ['user', 'a'.repeat(300)],
      ['assistant', 'b'.repeat(300)],
      ['user', 'c'.repeat(300)],
      ['assistant', 'd'.repeat(300)],
    ])
    const out = await run(inChat, 'chat_read', { id: 'a', before: 3, after: 3, maxChars: 800 })
    expect(out).toMatch(/truncated: \d+ more messages/)
    expect(out).toContain('around="')
  })

  it('refuses the current conversation and unknown, worker or routine chats', async () => {
    chat('w', { parentId: 'a' }, [['assistant', 'worker']])
    chat('r', { routineId: 'x' }, [['assistant', 'rotina']])
    expect(await run(inChat, 'chat_read', { id: 'current' })).toContain('current conversation')
    for (const id of ['w', 'r', 'nope']) expect(await run(inChat, 'chat_read', { id })).toContain('Error: no chat')
  })

  it('complains about a message that is not in the chat', async () => {
    chat('a', {}, long)
    expect(await run(inChat, 'chat_read', { id: 'a', around: 'zzz' })).toContain('is not in chat a')
  })

  it('in code, reads other projects only after a search showed them', async () => {
    chat('blog', { mode: 'code', directory: '/work/blog' }, [['user', 'segredo do blog: opalina']])
    chat('here', { mode: 'code', directory: '/work/orbit' }, [['user', 'segredo daqui']])
    expect(await run(inCode, 'chat_read', { id: 'here' })).toContain('segredo daqui')
    expect(await run(inCode, 'chat_read', { id: 'blog' })).toContain('outside this conversation')
    // A search the user allowed (scope "all") surfaces it for the rest of the conversation
    await run(inCode, 'chat_search', { query: 'opalina', scope: 'all' })
    expect(await run(inCode, 'chat_read', { id: 'blog' })).toContain('opalina')
    // Another conversation does not inherit it
    expect(await run({ ...inCode, sessionId: 'other-conv' }, 'chat_read', { id: 'blog' })).toContain('outside this conversation')
  })
})
