import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageInput } from '@shared/chat'

const mocks = vi.hoisted(() => ({
  runChat: vi.fn(async (_win: unknown, _input: SendMessageInput) => {}),
  broadcastSessionEvent: vi.fn(),
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
}))

vi.mock('../chat-engine', () => ({ runChat: mocks.runChat }))
vi.mock('../companion-server', () => ({ broadcastSessionEvent: mocks.broadcastSessionEvent }))
vi.mock('../ask-dispatch', () => ({ dispatchAsk: mocks.dispatchAsk }))
vi.mock('../subchats', () => ({ createSubchatRecord: mocks.createSubchatRecord }))

const { createSubchatTools } = await import('./subchats')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const exec = (tools: ReturnType<typeof createSubchatTools>, name: 'suggest_subchat' | 'open_subchat') =>
  (tools[name] as unknown as { execute: Exec }).execute

const BRIEF = 'Corrigir o split de aspas em csv-parser.ts:42 e cobrir com teste de importação.'

function input(overrides: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    sessionId: 'ses_pai',
    text: 'tem um bug no parser',
    providerId: 'anthropic',
    modelId: 'claude',
    mode: 'code',
    options: { permissionMode: 'ask' },
    directory: '/repo',
    language: 'Portuguese',
    ...overrides,
  } as SendMessageInput
}

const janela = {} as never

describe('suggest_subchat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dispatchAsk.mockResolvedValue('deny')
  })

  it('sugere antes de criar: manda o título e o brief para o card, sem abrir nada', async () => {
    await exec(createSubchatTools(input(), janela), 'suggest_subchat')(
      { title: 'Parser de CSV', brief: BRIEF },
      {},
    )
    expect(mocks.dispatchAsk).toHaveBeenCalledTimes(1)
    const pedido = mocks.dispatchAsk.mock.calls[0][1] as { kind: string; subchat: { title: string; brief: string } }
    expect(pedido.kind).toBe('subchat')
    expect(pedido.subchat).toEqual({ title: 'Parser de CSV', brief: BRIEF })
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(mocks.runChat).not.toHaveBeenCalled()
  })

  it('"implementar em novo chat" cria e já dispara o turno do filho', async () => {
    mocks.dispatchAsk.mockResolvedValue('new')
    const r = await exec(createSubchatTools(input(), janela), 'suggest_subchat')(
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

  it('"fazer neste chat" não cria nada e manda o agente trabalhar aqui', async () => {
    mocks.dispatchAsk.mockResolvedValue('here')
    const r = await exec(createSubchatTools(input(), janela), 'suggest_subchat')(
      { title: 'Parser de CSV', brief: BRIEF },
      {},
    )
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('THIS conversation')
  })

  it('"negar" deixa o assunto de lado', async () => {
    const r = await exec(createSubchatTools(input(), janela), 'suggest_subchat')(
      { title: 'Parser de CSV', brief: BRIEF },
      {},
    )
    expect(mocks.createSubchatRecord).not.toHaveBeenCalled()
    expect(String(r)).toContain('declined')
  })
})

describe('open_subchat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dispatchAsk.mockResolvedValue('deny')
  })

  it('cria direto, sem perguntar — só quando o usuário já pediu', async () => {
    const r = await exec(createSubchatTools(input(), janela), 'open_subchat')(
      { title: 'Parser de CSV', brief: BRIEF },
      {},
    )
    expect(mocks.dispatchAsk).not.toHaveBeenCalled()
    expect(mocks.createSubchatRecord).toHaveBeenCalledTimes(1)
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    expect(String(r)).toContain('already working')
  })

  it('sem janela não dispara turno nenhum (subagente efêmero)', async () => {
    await exec(createSubchatTools(input()), 'open_subchat')({ title: 'Parser de CSV', brief: BRIEF }, {})
    expect(mocks.createSubchatRecord).toHaveBeenCalledTimes(1)
    expect(mocks.runChat).not.toHaveBeenCalled()
  })

  it('conversa inexistente devolve erro e não dispara nada', async () => {
    mocks.createSubchatRecord.mockResolvedValueOnce(null as never)
    const r = await exec(createSubchatTools(input(), janela), 'open_subchat')(
      { title: 'Parser de CSV', brief: BRIEF },
      {},
    )
    expect(String(r)).toContain('Error')
    expect(mocks.runChat).not.toHaveBeenCalled()
  })
})
