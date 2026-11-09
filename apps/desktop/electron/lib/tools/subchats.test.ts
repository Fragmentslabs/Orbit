import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'

const mocks = vi.hoisted(() => ({
  runChat: vi.fn(async (_win: unknown, _input: SendMessageInput) => {}),
  wakeParentOf: vi.fn(),
  running: [] as string[],
  findSubchat: vi.fn(async (parentId: string, id: string) =>
    parentId === 'ses_pai' && id === 'ses_child'
      ? { id: 'ses_child', title: 'CSV parser', mode: 'code' as const, directory: '/repo', extraDirectories: [] }
      : null),
  readSubchatMessages: vi.fn(async () => ({
    from: 1,
    to: 2,
    total: 2,
    messages: [
      { index: 1, role: 'user' as const, text: 'You can start', tools: [] },
      { index: 2, role: 'assistant' as const, text: 'Parser pronto em csv-parser.ts', tools: ['write'] },
    ],
  })),
  broadcastSessionEvent: vi.fn(),
  broadcastChatEvent: vi.fn(),
  dispatchAsk: vi.fn(async (_target: string, _item: unknown, _signal?: AbortSignal) => 'deny'),
  createSubchatRecord: vi.fn(async () => ({
    id: 'ses_child',
    title: 'CSV parser',
    mode: 'code' as const,
    pinned: false,
    archived: false,
    folderId: null,
    directory: '/repo',
    extraDirectories: [],
    parentId: 'ses_pai',
    createdAt: 1,
    updatedAt: 1,
  })),
  // A new top-level chat: no parentId.
  createContinuationRecord: vi.fn(async () => ({
    id: 'ses_novo',
    title: 'Parser continuation',
    mode: 'code' as const,
    pinned: false,
    archived: false,
    folderId: null,
    directory: '/repo',
    extraDirectories: [],
    createdAt: 1,
    updatedAt: 1,
  })),
  modelSelect: vi.fn(),
}))

vi.mock('../chat-engine', () => ({ runChat: mocks.runChat, getRunningSessionIds: () => mocks.running }))
vi.mock('../companion-server', () => ({ broadcastSessionEvent: mocks.broadcastSessionEvent }))
vi.mock('../broadcast', () => ({ broadcastChatEvent: mocks.broadcastChatEvent }))
// The decision store is covered by its own test; here it is an in-memory set.
vi.mock('./specialist-offers', () => {
  const decided = new Set<string>()
  return {
    offerDecided: async (sessionId: string, profile: string) => decided.has(`${sessionId}:${profile}`),
    recordOfferDecision: async (sessionId: string, profile: string) => void decided.add(`${sessionId}:${profile}`),
  }
})
vi.mock('../agents/suggestions', () => ({
  suggestibleAgent: (id: string) => (id === 'agent:vid' ? { id: 'vid', name: 'Video agent' } : null),
  profileLabel: (id: string) => (id === 'agent:vid' ? 'Video agent' : id),
}))
vi.mock('../ask-dispatch', () => ({ dispatchAsk: mocks.dispatchAsk }))
vi.mock('../subchat-wake', () => ({ wakeParentOf: mocks.wakeParentOf }))
vi.mock('../subchats', () => ({
  createSubchatRecord: mocks.createSubchatRecord,
  createContinuationRecord: mocks.createContinuationRecord,
  findSubchat: mocks.findSubchat,
  readSubchatMessages: mocks.readSubchatMessages,
}))

const { createSubchatTools, withSpecialistOffer } = await import('./subchats')
const { currentTurnWrites, recordToolWrite, runWithWriteScope } = await import('../session/write-journal')
const { setMainLocale } = await import('../i18n')

// The child's opening lines follow the app language; these tests run the app in English.
setMainLocale('English')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const exec = (tools: ReturnType<typeof createSubchatTools>, name: 'suggest_subchat' | 'open_subchat' | 'read_subchat' | 'send_to_subchat') =>
  (tools[name] as unknown as { execute: Exec }).execute

const BRIEF = 'Fix the quote split in csv-parser.ts:42 and cover it with an import test.'

function input(overrides: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    sessionId: 'ses_pai',
    text: 'the parser has a bug',
    providerId: 'anthropic',
    modelId: 'claude',
    mode: 'code',
    options: { permissionMode: 'ask' },
    directory: '/repo',
    language: 'English',
    ...overrides,
  } as SendMessageInput
}

const win = {} as never

describe('suggest_subchat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dispatchAsk.mockResolvedValue('deny')
  })

  it('suggests before creating: sends the title and the brief to the card, opening nothing', async () => {
    await exec(createSubchatTools(input(), win), 'suggest_subchat')(
      { title: 'CSV parser', brief: BRIEF },
      {},
    )
    expect(mocks.dispatchAsk).toHaveBeenCalledTimes(1)
    const request = mocks.dispatchAsk.mock.calls[0][1] as {
      kind: string
      subchat: { title: string; brief: string; scope: string }
    }
    expect(request.kind).toBe('subchat')
    expect(request.subchat).toEqual({ title: 'CSV parser', brief: BRIEF, scope: 'subchat' })
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(mocks.runChat).not.toHaveBeenCalled()
  })

  it('suggests a listed agent: the card carries its id, and accepting opens that agent\'s chat', async () => {
    mocks.dispatchAsk.mockResolvedValue('new')
    const result = await exec(createSubchatTools(input({ sessionId: 'ses_pai' }), win), 'suggest_subchat')(
      { title: 'Video', brief: BRIEF, agent: 'agent:vid' },
      {},
    )
    const request = mocks.dispatchAsk.mock.calls[0][1] as { subchat: { profile?: string } }
    expect(request.subchat.profile).toBe('agent:vid')
    expect(mocks.createSubchatRecord).toHaveBeenCalledWith(expect.objectContaining({ profile: 'agent:vid' }))
    expect(String(result)).toContain('Video agent chat was opened')
  })

  it('refuses an agent that is not in the catalog, without asking the user', async () => {
    const result = await exec(createSubchatTools(input(), win), 'suggest_subchat')({ title: 'X', brief: BRIEF, agent: 'agent:nope' }, {})
    expect(String(result)).toContain('no agent')
    expect(mocks.dispatchAsk).not.toHaveBeenCalled()
  })

  it('never suggests the same agent twice in a conversation, whatever the first answer was', async () => {
    mocks.dispatchAsk.mockResolvedValue('deny')
    const tools = createSubchatTools(input({ sessionId: 'ses_once' }), win)
    await exec(tools, 'suggest_subchat')({ title: 'Video', brief: BRIEF, agent: 'agent:vid' }, {})
    const again = await exec(tools, 'suggest_subchat')({ title: 'Video', brief: BRIEF, agent: 'agent:vid' }, {})
    expect(mocks.dispatchAsk).toHaveBeenCalledTimes(1)
    expect(String(again)).toContain('do not suggest it again')
  })

  it('a specialist chat or a worker does not suggest agents', async () => {
    const tools = createSubchatTools(input({ orchestrationRole: 'worker' }), win)
    const result = await exec(tools, 'suggest_subchat')({ title: 'Video', brief: BRIEF, agent: 'agent:vid' }, {})
    expect(String(result)).toContain('not suggested from here')
    expect(mocks.dispatchAsk).not.toHaveBeenCalled()
  })

  it('a long conversation suggests a NEW chat, not a subchat', async () => {
    mocks.dispatchAsk.mockResolvedValue('new')
    const r = await exec(createSubchatTools(input(), win), 'suggest_subchat')(
      { title: 'Parser continuation', brief: BRIEF, scope: 'chat' },
      {},
    )
    const request = mocks.dispatchAsk.mock.calls[0][1] as { subchat: { scope: string } }
    expect(request.subchat.scope).toBe('chat')
    // Top-level: no parentId, so it is not indented under (nor deleted with) this chat.
    expect(mocks.createContinuationRecord).toHaveBeenCalledWith({
      sourceId: 'ses_pai',
      title: 'Parser continuation',
      body: BRIEF,
    })
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    expect(String(r)).toContain('top-level')
  })

  it('the new top-level chat starts on the model of the conversation it came from', async () => {
    mocks.dispatchAsk.mockResolvedValue('new')
    const webContents = { send: mocks.modelSelect }
    const realWin = { webContents } as never
    await exec(createSubchatTools(input(), realWin), 'suggest_subchat')(
      { title: 'Parser continuation', brief: BRIEF, scope: 'chat' },
      {},
    )
    expect(mocks.modelSelect).toHaveBeenCalledWith('companion:model-select', {
      providerId: 'anthropic',
      modelId: 'claude',
      sessionId: 'ses_novo',
    })
  })

  it('"implement in a new chat" creates and already fires the child turn', async () => {
    mocks.dispatchAsk.mockResolvedValue('new')
    const r = await exec(createSubchatTools(input(), win), 'suggest_subchat')(
      { title: 'CSV parser', brief: BRIEF },
      {},
    )
    expect(mocks.createSubchatRecord).toHaveBeenCalledWith({
      parentId: 'ses_pai',
      title: 'CSV parser',
      body: BRIEF,
    })
    expect(mocks.broadcastSessionEvent).toHaveBeenCalledTimes(1)
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    const [, filho] = mocks.runChat.mock.calls[0] as [unknown, SendMessageInput]
    expect(filho.sessionId).toBe('ses_child')
    expect(filho.text).toContain('Go ahead')
    expect(filho.directory).toBe('/repo')
    expect(String(r)).toContain('already working')
  })

  it('"do it in this chat" creates nothing and tells the agent to work here', async () => {
    mocks.dispatchAsk.mockResolvedValue('here')
    const r = await exec(createSubchatTools(input(), win), 'suggest_subchat')(
      { title: 'CSV parser', brief: BRIEF },
      {},
    )
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(mocks.runChat).not.toHaveBeenCalled()
    // The task comes back with the choice, so the agent does not lose track of it.
    expect(String(r)).toBe(`The user chose to do it here. Do it now in this conversation, without opening a chat: CSV parser — ${BRIEF}`)
  })

  it('"decline" leaves the matter aside', async () => {
    const r = await exec(createSubchatTools(input(), win), 'suggest_subchat')(
      { title: 'CSV parser', brief: BRIEF },
      {},
    )
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(String(r)).toContain('declined')
  })

  it('the card is closed when the request ends — answered, aborted or failed', async () => {
    const tools = createSubchatTools(input(), win)
    await exec(tools, 'suggest_subchat')({ title: 'CSV parser', brief: BRIEF }, {})
    const done = mocks.broadcastChatEvent.mock.calls.at(-1)?.[0] as { type: string; sessionId: string }
    expect(done.type).toBe('ask:done')
    expect(done.sessionId).toBe('ses_pai')

    vi.clearAllMocks()
    mocks.dispatchAsk.mockRejectedValueOnce(new Error('aborted'))
    await exec(tools, 'suggest_subchat')({ title: 'CSV parser', brief: BRIEF }, {})
    expect((mocks.broadcastChatEvent.mock.calls.at(-1)?.[0] as { type: string }).type).toBe('ask:done')
  })
})

describe('open_subchat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dispatchAsk.mockResolvedValue('deny')
  })

  it('creates directly, without asking — only when the user already asked', async () => {
    const r = await exec(createSubchatTools(input(), win), 'open_subchat')(
      { title: 'CSV parser', brief: BRIEF },
      {},
    )
    expect(mocks.dispatchAsk).not.toHaveBeenCalled()
    expect(mocks.createSubchatRecord).toHaveBeenCalledTimes(1)
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    expect(String(r)).toContain('already working')
  })

  it('the child runs outside the parent write scope: what it writes is not the parent\'s', async () => {
    // The child is another conversation, with its own revert, fired without await.
    let filho: Promise<void> | undefined
    // The real runChat opens the child's turn scope.
    mocks.runChat.mockImplementationOnce(async () => {
      filho = runWithWriteScope(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        recordToolWrite('/repo/from-child.ts')
      })
      await filho
    })
    await runWithWriteScope(async () => {
      await exec(createSubchatTools(input(), win), 'open_subchat')({ title: 'CSV parser', brief: BRIEF }, {})
      await filho
      expect(currentTurnWrites('/repo')).toEqual({ authored: [], others: ['from-child.ts'] })
    })
  })

  it('opened from a worker, it hangs from the PERSON\'s chat — not from the worker', async () => {
    await exec(
      createSubchatTools(input({ sessionId: 'ses_worker', orchestrationRole: 'worker', parentSessionId: 'ses_pai' }), win),
      'open_subchat',
    )({ title: 'CSV parser', brief: BRIEF }, {})
    expect(mocks.createSubchatRecord).toHaveBeenCalledWith({
      parentId: 'ses_pai',
      title: 'CSV parser',
      body: BRIEF,
    })
  })

  it('with no win it fires no turn (ephemeral subagent)', async () => {
    await exec(createSubchatTools(input()), 'open_subchat')({ title: 'CSV parser', brief: BRIEF }, {})
    expect(mocks.createSubchatRecord).toHaveBeenCalledTimes(1)
    expect(mocks.runChat).not.toHaveBeenCalled()
  })

  it('a nonexistent conversation returns an error and fires nothing', async () => {
    mocks.createSubchatRecord.mockResolvedValueOnce(null as never)
    const r = await exec(createSubchatTools(input(), win), 'open_subchat')(
      { title: 'CSV parser', brief: BRIEF },
      {},
    )
    expect(String(r)).toContain('Error')
    expect(mocks.runChat).not.toHaveBeenCalled()
  })
})

describe('send_to_subchat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.running.length = 0
  })

  it('fires a turn in the child with the instruction, without waiting for the answer', async () => {
    const r = await exec(createSubchatTools(input(), win), 'send_to_subchat')(
      { subchatId: 'ses_child', message: 'Now cover escaped quotes' },
      {},
    )
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    const [, filho] = mocks.runChat.mock.calls[0] as [unknown, SendMessageInput]
    expect(filho.sessionId).toBe('ses_child')
    expect(filho.directory).toBe('/repo')
    // In the child's chat the message says where it came from, in the app language.
    expect(filho.text).toBe('Message from the main chat: Now cover escaped quotes')
    expect(String(r)).toContain('Instruction sent')
    // When the child's turn ends, its result goes back to the parent.
    await vi.waitFor(() => expect(mocks.wakeParentOf).toHaveBeenCalledWith(win, expect.anything(), expect.objectContaining({ id: 'ses_child' })))
    // It does not ask on its own: the card is the permission gate (rules.ts).
    expect(mocks.dispatchAsk).not.toHaveBeenCalled()
  })

  it('only instructs a child of THIS conversation', async () => {
    const r = await exec(createSubchatTools(input({ sessionId: 'ses_other' }), win), 'send_to_subchat')(
      { subchatId: 'ses_child', message: 'Now cover escaped quotes' },
      {},
    )
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('No subchat')
  })

  it('refuses a child that is still running a turn', async () => {
    mocks.running.push('ses_child')
    const r = await exec(createSubchatTools(input(), win), 'send_to_subchat')(
      { subchatId: 'ses_child', message: 'Now cover escaped quotes' },
      {},
    )
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('busy')
  })

  it('two instructions in the same step: the second is refused', async () => {
    const tools = createSubchatTools(input(), win)
    const send = exec(tools, 'send_to_subchat')
    const args = { subchatId: 'ses_child', message: 'Now cover escaped quotes' }
    const [a, b] = await Promise.all([send(args, {}), send(args, {})])
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    expect([String(a), String(b)].filter((t) => t.includes('busy'))).toHaveLength(1)
  })

  it('the instruction runs outside the parent write scope', async () => {
    let filho: Promise<void> | undefined
    mocks.runChat.mockImplementationOnce(async () => {
      filho = runWithWriteScope(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        recordToolWrite('/repo/from-child.ts')
      })
      await filho
    })
    await runWithWriteScope(async () => {
      await exec(createSubchatTools(input(), win), 'send_to_subchat')(
        { subchatId: 'ses_child', message: 'Now cover escaped quotes' },
        {},
      )
      await filho
      expect(currentTurnWrites('/repo')).toEqual({ authored: [], others: ['from-child.ts'] })
    })
  })

  it('with no win it fires nothing', async () => {
    const r = await exec(createSubchatTools(input()), 'send_to_subchat')(
      { subchatId: 'ses_child', message: 'Now cover escaped quotes' },
      {},
    )
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('needs the app win')
  })
})

describe('read_subchat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.running.length = 0
  })

  it('returns the child conversation with the status', async () => {
    mocks.running.push('ses_child')
    const r = String(
      await exec(createSubchatTools(input(), win), 'read_subchat')({ subchatId: 'ses_child' }, {}),
    )
    expect(r).toContain('CSV parser')
    expect(r).toContain('running a turn now')
    expect(r).toContain('Parser pronto em csv-parser.ts')
    expect(r).toContain('[tools: write]')
    expect(mocks.runChat).not.toHaveBeenCalled()
  })

  it('an id from another conversation reads nothing', async () => {
    const r = await exec(createSubchatTools(input({ sessionId: 'ses_other' }), win), 'read_subchat')(
      { subchatId: 'ses_child' },
      {},
    )
    expect(String(r)).toContain('No subchat')
    expect(mocks.readSubchatMessages).not.toHaveBeenCalled()
  })
})

describe('tool descriptions', () => {
  // How to call each tool lives here, not in the system prompt (SUBCHAT_INSTRUCTION
  // keeps only the proactive triggers) — so these lines must not go missing.
  const tools = createSubchatTools(input(), win) as unknown as Record<string, { description: string; inputSchema: unknown }>

  it('open_subchat is only for an explicit request', () => {
    expect(tools.open_subchat.description).toContain('ONLY when the user explicitly asked')
    expect(tools.open_subchat.description).toContain('suggest_subchat')
  })

  it('send_to_subchat is preferred over opening another subchat', () => {
    expect(tools.send_to_subchat.description).toContain('Prefer this over opening a new subchat')
    expect(tools.read_subchat.description).toContain('subchats list')
  })

  it('suggest_subchat leaves the choice to the user, and its schema carries the brief and the scope rules', () => {
    expect(tools.suggest_subchat.description).toContain('you never open a chat by yourself')
    const schema = JSON.stringify(z.toJSONSchema(tools.suggest_subchat.inputSchema as z.ZodType))
    expect(schema).toContain('exact paths')
    expect(schema).toContain('NEW top-level conversation')
  })
})

describe('withSpecialistOffer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dispatchAsk.mockResolvedValue('deny')
  })

  const make = () => {
    const run = vi.fn(async () => 'written')
    const tools = { motion_write: { description: 'x', execute: run }, fragment_create: { description: 'f', execute: run }, other: { description: 'y', execute: vi.fn() } } as never
    return { run, tools }
  }
  const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
    (tools[name] as { execute: Exec }).execute(args, {})

  it('offers a Motion chat before creating a composition, naming the specialist on the card', async () => {
    const { run, tools } = make()
    const wrapped = withSpecialistOffer(tools, input({ sessionId: 'offer-1', text: 'animate my logo' }), win)
    await call(wrapped, 'motion_write', { name: 'logo' })
    const request = mocks.dispatchAsk.mock.calls[0][1] as { subchat: { profile: string; title: string; brief: string } }
    expect(request.subchat.profile).toBe('motion')
    expect(request.subchat.title).toContain('logo')
    expect(request.subchat.brief).toBe('animate my logo')
    expect(run).not.toHaveBeenCalled()
  })

  it('opens a specialist subchat on "new" and creates nothing here', async () => {
    mocks.dispatchAsk.mockResolvedValue('new')
    const { run, tools } = make()
    const wrapped = withSpecialistOffer(tools, input({ sessionId: 'offer-2' }), win)
    const result = await call(wrapped, 'motion_write', { name: 'intro' })
    expect(mocks.createSubchatRecord).toHaveBeenCalledWith(expect.objectContaining({ profile: 'motion' }))
    expect(String(result)).toContain('motion chat')
    expect(run).not.toHaveBeenCalled()
  })

  it('passes the fragment kind the agent asked for into the new subchat', async () => {
    mocks.dispatchAsk.mockResolvedValue('new')
    const { tools } = make()
    const wrapped = withSpecialistOffer(tools, input({ sessionId: 'offer-kind' }), win)
    await call(wrapped, 'fragment_create', { name: 'clock', kind: 'widget' })
    expect(mocks.createSubchatRecord).toHaveBeenCalledWith(expect.objectContaining({ profile: 'fragment', fragmentKind: 'widget' }))
  })

  it('on "here" runs the original tool and does not ask again in that conversation', async () => {
    mocks.dispatchAsk.mockResolvedValue('here')
    const { run, tools } = make()
    const wrapped = withSpecialistOffer(tools, input({ sessionId: 'offer-3' }), win)
    await call(wrapped, 'motion_write', { name: 'a' })
    await call(wrapped, 'motion_write', { name: 'b' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(mocks.dispatchAsk).toHaveBeenCalledTimes(1)
  })

  it('also offers a fragment chat before a fragment is created', async () => {
    const run = vi.fn(async () => 'created')
    const tools = { fragment_create: { description: 'x', execute: run } } as never
    const wrapped = withSpecialistOffer(tools, input({ sessionId: 'offer-4', text: 'a habit tracker' }), win)
    await call(wrapped, 'fragment_create', { name: 'Habits' })
    const request = mocks.dispatchAsk.mock.calls[0][1] as { subchat: { profile: string; title: string } }
    expect(request.subchat.profile).toBe('fragment')
    expect(request.subchat.title).toContain('Habits')
    expect(run).not.toHaveBeenCalled()
  })

  it('never wraps a specialist chat, a worker or a turn without a window', () => {
    const { tools } = make()
    expect(withSpecialistOffer(tools, input({ options: { profile: 'motion' } }), win)).toBe(tools)
    expect(withSpecialistOffer(tools, input({ orchestrationRole: 'worker' }), win)).toBe(tools)
    expect(withSpecialistOffer(tools, input(), undefined)).toBe(tools)
  })
})
