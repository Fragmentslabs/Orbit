import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'

const store = new Map<string, unknown>()

vi.mock('./storage', () => ({
  readJson: vi.fn(async (key: string) => store.get(key) ?? null),
  writeJson: vi.fn(async (key: string, value: unknown) => {
    store.set(key, value)
  }),
  listKeys: vi.fn(async (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix))),
}))

const { createSubchatRecord, findSubchat, formatSubchatsBlock, listSubchats, readSubchatMessages } = await import('./subchats')

const T0 = 1_000_000

function session(id: string, parentId?: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: id,
    mode: 'code',
    pinned: false,
    archived: false,
    folderId: 'folder-1',
    directory: '/tmp/project',
    extraDirectories: ['/tmp/extra'],
    ...(parentId ? { parentId } : {}),
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  }
}

function text(id: string, role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role,
    parts: [{ id: `${id}-p`, type: 'text', text, state: 'done' }],
    createdAt: T0,
    ...extra,
  }
}

describe('listSubchats', () => {
  it('lists only the attached conversations, with the last result of each one', async () => {
    store.clear()
    store.set('session/parent', session('parent'))
    store.set('session/f1', session('f1', 'parent', { title: 'Report layout', updatedAt: T0 + 20 }))
    store.set('session/f2', session('f2', 'parent', { title: 'CSV parser', updatedAt: T0 + 10 }))
    // An orchestration worker has a parentId, but it is workers.ts' business
    store.set(
      'session/w1',
      session('w1', 'parent', {
        orchestration: { role: 'worker', parentSessionId: 'parent', task: 'Backend' },
        updatedAt: T0 + 30,
      }),
    )
    // Archived ones leave the list
    store.set('session/archived', session('archived', 'parent', { archived: true, updatedAt: T0 + 40 }))
    // From another parent it does not enter
    store.set('session/other', session('other', 'x', { updatedAt: T0 + 50 }))

    store.set('messages/f1', [
      text('m1', 'user', 'fix the header'),
      text('m2', 'assistant', 'The header now wraps in two lines.'),
    ])
    // No answer yet: the brief serves as the result
    store.set('messages/f2', [text('m3', 'assistant', 'Summary of the conversation so far:\n\nMigrate the split.', { summary: true })])

    const list = await listSubchats('parent')
    expect(list.map((r) => r.session.id)).toEqual(['f1', 'f2'])
    expect(list[0].result).toBe('The header now wraps in two lines.')
    // The summary marker does not leak into the parent's context
    expect(list[1].result).toBe('Migrate the split.')
  })

  it('returns nothing when the conversation has no children', async () => {
    store.clear()
    store.set('session/parent', session('parent'))
    expect(await listSubchats('parent')).toEqual([])
  })
})

describe('createSubchatRecord', () => {
  it('inherits mode and folders from the parent and opens with the brief as the system summary', async () => {
    store.clear()
    store.set('session/parent', session('parent', undefined, { mode: 'chat', directory: '/tmp/other' }))

    const child = await createSubchatRecord({ parentId: 'parent', title: '  CSV parser  ', body: 'Swap the split.' })
    expect(child).not.toBeNull()
    expect(child!.title).toBe('CSV parser')
    expect(child!.parentId).toBe('parent')
    expect(child!.mode).toBe('chat')
    expect(child!.directory).toBe('/tmp/other')
    expect(child!.extraDirectories).toEqual(['/tmp/extra'])
    expect(child!.folderId).toBe('folder-1')

    expect(store.get(`session/${child!.id}`)).toEqual(child)
    const messages = store.get(`messages/${child!.id}`) as ChatMessage[]
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].summary).toBe(true)
    expect(messages[0].continuation).toBe(true)
    const body = (messages[0].parts[0] as { text: string }).text
    // The marker exists for the new chat's model to read as context…
    expect(body.startsWith('Summary of the conversation so far:')).toBe(true)
    expect(body).toContain('Swap the split.')
  })

  it('marks a specialist subchat: motion/design by profile, a fragment chat by its own field', async () => {
    store.clear()
    store.set('session/parent', session('parent', undefined, { mode: 'chat' }))
    const motion = await createSubchatRecord({ parentId: 'parent', title: 'M', body: 'b', profile: 'motion' })
    expect(motion!.profile).toBe('motion')
    expect(motion!.fragment).toBeUndefined()
    const fragment = await createSubchatRecord({ parentId: 'parent', title: 'F', body: 'b', profile: 'fragment' })
    expect(fragment!.fragment).toEqual({ kind: 'screen' })
    expect(fragment!.profile).toBeUndefined()
    const widget = await createSubchatRecord({ parentId: 'parent', title: 'W', body: 'b', profile: 'fragment', fragmentKind: 'panel' })
    expect(widget!.fragment).toEqual({ kind: 'panel' })
    const plain = await createSubchatRecord({ parentId: 'parent', title: 'P', body: 'b' })
    expect(plain!.profile).toBeUndefined()
    expect(plain!.fragment).toBeUndefined()
  })

  it('creates nothing when the parent does not exist', async () => {
    store.clear()
    expect(await createSubchatRecord({ parentId: 'ghost', title: 'X', body: 'Y' })).toBeNull()
  })
})

describe('formatSubchatsBlock with artifacts', () => {
  const child = { id: 'c1', title: 'Logo animation', createdAt: Date.now() } as never

  it('lists what a specialist subchat made and says the parent can act on it', () => {
    const block = formatSubchatsBlock([{ session: child, result: 'Done', artifacts: ['motion "logo" (id mv_9 — pass it as `id`)'] }])
    expect(block).toContain('Made: motion "logo"')
    expect(block).toContain('no need to send it back')
  })

  it('stays as before when no subchat made anything', () => {
    const block = formatSubchatsBlock([{ session: child, result: 'Done' }])
    expect(block).not.toContain('Made:')
    expect(block).not.toContain('no need to send it back')
  })
})

describe('formatSubchatsBlock', () => {
  it('is empty without subchats', () => {
    expect(formatSubchatsBlock([])).toBe('')
  })

  it('lists title and last result, cutting the long text', async () => {
    store.clear()
    store.set('session/parent', session('parent'))
    store.set('session/f1', session('f1', 'parent', { title: 'Layout' }))
    store.set('messages/f1', [text('m1', 'assistant', 'A'.repeat(1200))])

    const block = formatSubchatsBlock(await listSubchats('parent'))
    expect(block).toContain('Subchats opened from this conversation')
    expect(block).toContain('**Layout**')
    // The id is what the model uses in read_subchat / send_to_subchat.
    expect(block).toContain('id: f1')
    expect(block).toContain('send_to_subchat')
    expect(block).toContain('Latest: AAAA')
    expect(block).toContain('…')
    expect(block.length).toBeLessThan(1200)
  })
})

describe('findSubchat', () => {
  it('returns only the child of the conversation asking', async () => {
    store.clear()
    store.set('session/parent', session('parent'))
    store.set('session/other', session('other'))
    store.set('session/f1', session('f1', 'parent'))
    expect((await findSubchat('parent', 'f1'))?.id).toBe('f1')
    // Id from another tree, loose conversation and invented id: they never count.
    expect(await findSubchat('other', 'f1')).toBeNull()
    expect(await findSubchat('parent', 'other')).toBeNull()
    expect(await findSubchat('parent', 'ghost')).toBeNull()
  })

  it('refuses an orchestration worker — those are workers.ts business', async () => {
    store.clear()
    store.set('session/w1', session('w1', 'parent', { orchestration: { role: 'worker', parentSessionId: 'parent' } as never }))
    expect(await findSubchat('parent', 'w1')).toBeNull()
  })
})

describe('readSubchatMessages', () => {
  const ten = Array.from({ length: 10 }, (_, i) => text(`m${i}`, i % 2 ? 'assistant' : 'user', `message ${i}`))

  it('returns the last ones, from oldest to newest', async () => {
    store.clear()
    store.set('messages/f1', ten)
    const r = await readSubchatMessages('f1', 3)
    expect(r).toMatchObject({ from: 8, to: 10, total: 10 })
    expect(r.messages.map((m) => m.text)).toEqual(['message 7', 'message 8', 'message 9'])
  })

  it('pages backwards with skip', async () => {
    store.clear()
    store.set('messages/f1', ten)
    const r = await readSubchatMessages('f1', 3, 3)
    expect(r).toMatchObject({ from: 5, to: 7 })
    expect(r.messages[0].text).toBe('message 4')
  })

  it('cuts a long message and lists the tools by name only', async () => {
    store.clear()
    store.set('messages/f1', [
      {
        ...text('m1', 'assistant', 'A'.repeat(6000)),
        parts: [
          { id: 'p1', type: 'text', text: 'A'.repeat(6000), state: 'done' },
          { id: 'p2', type: 'tool', tool: 'bash', state: 'done' },
        ],
      } as ChatMessage,
    ])
    const [m] = (await readSubchatMessages('f1', 5)).messages
    expect(m.text.length).toBeLessThan(4100)
    expect(m.text).toContain('[truncated]')
    expect(m.tools).toEqual(['bash'])
  })

  it('a subchat without messages returns empty', async () => {
    store.clear()
    expect(await readSubchatMessages('f1', 5)).toMatchObject({ total: 0, messages: [] })
  })
})
