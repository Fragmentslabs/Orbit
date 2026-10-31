import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageInput } from '@shared/chat'

const mocks = vi.hoisted(() => ({
  runChat: vi.fn(async (_win: unknown, _input: SendMessageInput) => {}),
  wakeParentOf: vi.fn(),
  running: [] as string[],
  findSubchat: vi.fn(async (parentId: string, id: string) =>
    parentId === 'ses_pai' && id === 'ses_filho'
      ? { id: 'ses_filho', title: 'Parser de CSV', mode: 'code' as const, directory: '/repo', extraDirectories: [] }
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
    id: 'ses_filho',
    title: 'Parser de CSV',
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
    title: 'Continuação do parser',
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
vi.mock('../ask-dispatch', () => ({ dispatchAsk: mocks.dispatchAsk }))
vi.mock('../subchat-wake', () => ({ wakeParentOf: mocks.wakeParentOf }))
vi.mock('../subchats', () => ({
  createSubchatRecord: mocks.createSubchatRecord,
  createContinuationRecord: mocks.createContinuationRecord,
  findSubchat: mocks.findSubchat,
  readSubchatMessages: mocks.readSubchatMessages,
}))

const { createSubchatTools } = await import('./subchats')
const { currentTurnWrites, recordToolWrite, runWithWriteScope } = await import('../session/write-journal')
const { setMainLocale } = await import('../i18n')

// The child's opening lines follow the app language; these tests run the app in Portuguese.
setMainLocale('Portuguese')

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
    language: 'Portuguese',
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
      { title: 'Parser de CSV', brief: BRIEF },
      {},
    )
    expect(mocks.dispatchAsk).toHaveBeenCalledTimes(1)
    const request = mocks.dispatchAsk.mock.calls[0][1] as {
      kind: string
      subchat: { title: string; brief: string; scope: string }
    }
    expect(request.kind).toBe('subchat')
    expect(request.subchat).toEqual({ title: 'Parser de CSV', brief: BRIEF, scope: 'subchat' })
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(mocks.runChat).not.toHaveBeenCalled()
  })

  it('a long conversation suggests a NEW chat, not a subchat', async () => {
    mocks.dispatchAsk.mockResolvedValue('new')
    const r = await exec(createSubchatTools(input(), win), 'suggest_subchat')(
      { title: 'Continuação do parser', brief: BRIEF, scope: 'chat' },
      {},
    )
    const request = mocks.dispatchAsk.mock.calls[0][1] as { subchat: { scope: string } }
    expect(request.subchat.scope).toBe('chat')
    // Top-level: no parentId, so it is not indented under (nor deleted with) this chat.
    expect(mocks.createContinuationRecord).toHaveBeenCalledWith({
      sourceId: 'ses_pai',
      title: 'Continuação do parser',
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
      { title: 'Continuação do parser', brief: BRIEF, scope: 'chat' },
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
      { title: 'Parser de CSV', brief: BRIEF },
      {},
    )
    expect(mocks.createSubchatRecord).toHaveBeenCalledWith({
      parentId: 'ses_pai',
      title: 'Parser de CSV',
      body: BRIEF,
    })
    expect(mocks.broadcastSessionEvent).toHaveBeenCalledTimes(1)
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    const [, filho] = mocks.runChat.mock.calls[0] as [unknown, SendMessageInput]
    expect(filho.sessionId).toBe('ses_filho')
    expect(filho.text).toContain('Pode começar')
    expect(filho.directory).toBe('/repo')
    expect(String(r)).toContain('already working')
  })

  it('"do it in this chat" creates nothing and tells the agent to work here', async () => {
    mocks.dispatchAsk.mockResolvedValue('here')
    const r = await exec(createSubchatTools(input(), win), 'suggest_subchat')(
      { title: 'Parser de CSV', brief: BRIEF },
      {},
    )
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('THIS conversation')
  })

  it('"decline" leaves the matter aside', async () => {
    const r = await exec(createSubchatTools(input(), win), 'suggest_subchat')(
      { title: 'Parser de CSV', brief: BRIEF },
      {},
    )
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(String(r)).toContain('declined')
  })

  it('the card is closed when the request ends — answered, aborted or failed', async () => {
    const tools = createSubchatTools(input(), win)
    await exec(tools, 'suggest_subchat')({ title: 'Parser de CSV', brief: BRIEF }, {})
    const done = mocks.broadcastChatEvent.mock.calls.at(-1)?.[0] as { type: string; sessionId: string }
    expect(done.type).toBe('ask:done')
    expect(done.sessionId).toBe('ses_pai')

    vi.clearAllMocks()
    mocks.dispatchAsk.mockRejectedValueOnce(new Error('aborted'))
    await exec(tools, 'suggest_subchat')({ title: 'Parser de CSV', brief: BRIEF }, {})
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
      { title: 'Parser de CSV', brief: BRIEF },
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
        recordToolWrite('/repo/do-filho.ts')
      })
      await filho
    })
    await runWithWriteScope(async () => {
      await exec(createSubchatTools(input(), win), 'open_subchat')({ title: 'Parser de CSV', brief: BRIEF }, {})
      await filho
      expect(currentTurnWrites('/repo')).toEqual({ authored: [], others: ['do-filho.ts'] })
    })
  })

  it('opened from a worker, it hangs from the PERSON\'s chat — not from the worker', async () => {
    await exec(
      createSubchatTools(input({ sessionId: 'ses_worker', orchestrationRole: 'worker', parentSessionId: 'ses_pai' }), win),
      'open_subchat',
    )({ title: 'Parser de CSV', brief: BRIEF }, {})
    expect(mocks.createSubchatRecord).toHaveBeenCalledWith({
      parentId: 'ses_pai',
      title: 'Parser de CSV',
      body: BRIEF,
    })
  })

  it('with no win it fires no turn (ephemeral subagent)', async () => {
    await exec(createSubchatTools(input()), 'open_subchat')({ title: 'Parser de CSV', brief: BRIEF }, {})
    expect(mocks.createSubchatRecord).toHaveBeenCalledTimes(1)
    expect(mocks.runChat).not.toHaveBeenCalled()
  })

  it('a nonexistent conversation returns an error and fires nothing', async () => {
    mocks.createSubchatRecord.mockResolvedValueOnce(null as never)
    const r = await exec(createSubchatTools(input(), win), 'open_subchat')(
      { title: 'Parser de CSV', brief: BRIEF },
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
      { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
      {},
    )
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    const [, filho] = mocks.runChat.mock.calls[0] as [unknown, SendMessageInput]
    expect(filho.sessionId).toBe('ses_filho')
    expect(filho.directory).toBe('/repo')
    // In the child's chat the message says where it came from, in the app language.
    expect(filho.text).toBe('Mensagem do chat principal: Agora cubra aspas escapadas')
    expect(String(r)).toContain('Instruction sent')
    // When the child's turn ends, its result goes back to the parent.
    await vi.waitFor(() => expect(mocks.wakeParentOf).toHaveBeenCalledWith(win, expect.anything(), expect.objectContaining({ id: 'ses_filho' })))
    // It does not ask on its own: the card is the permission gate (rules.ts).
    expect(mocks.dispatchAsk).not.toHaveBeenCalled()
  })

  it('only instructs a child of THIS conversation', async () => {
    const r = await exec(createSubchatTools(input({ sessionId: 'ses_other' }), win), 'send_to_subchat')(
      { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
      {},
    )
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('No subchat')
  })

  it('refuses a child that is still running a turn', async () => {
    mocks.running.push('ses_filho')
    const r = await exec(createSubchatTools(input(), win), 'send_to_subchat')(
      { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
      {},
    )
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('busy')
  })

  it('two instructions in the same step: the second is refused', async () => {
    const tools = createSubchatTools(input(), win)
    const send = exec(tools, 'send_to_subchat')
    const args = { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' }
    const [a, b] = await Promise.all([send(args, {}), send(args, {})])
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    expect([String(a), String(b)].filter((t) => t.includes('busy'))).toHaveLength(1)
  })

  it('the instruction runs outside the parent write scope', async () => {
    let filho: Promise<void> | undefined
    mocks.runChat.mockImplementationOnce(async () => {
      filho = runWithWriteScope(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        recordToolWrite('/repo/do-filho.ts')
      })
      await filho
    })
    await runWithWriteScope(async () => {
      await exec(createSubchatTools(input(), win), 'send_to_subchat')(
        { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
        {},
      )
      await filho
      expect(currentTurnWrites('/repo')).toEqual({ authored: [], others: ['do-filho.ts'] })
    })
  })

  it('with no win it fires nothing', async () => {
    const r = await exec(createSubchatTools(input()), 'send_to_subchat')(
      { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
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
    mocks.running.push('ses_filho')
    const r = String(
      await exec(createSubchatTools(input(), win), 'read_subchat')({ subchatId: 'ses_filho' }, {}),
    )
    expect(r).toContain('Parser de CSV')
    expect(r).toContain('running a turn now')
    expect(r).toContain('Parser pronto em csv-parser.ts')
    expect(r).toContain('[tools: write]')
    expect(mocks.runChat).not.toHaveBeenCalled()
  })

  it('an id from another conversation reads nothing', async () => {
    const r = await exec(createSubchatTools(input({ sessionId: 'ses_other' }), win), 'read_subchat')(
      { subchatId: 'ses_filho' },
      {},
    )
    expect(String(r)).toContain('No subchat')
    expect(mocks.readSubchatMessages).not.toHaveBeenCalled()
  })
})
