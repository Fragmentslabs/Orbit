import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageInput } from '@shared/chat'

const mocks = vi.hoisted(() => ({
  runChat: vi.fn(async (_win: unknown, _input: SendMessageInput) => {}),
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
      { index: 1, role: 'user' as const, text: 'Pode começar', tools: [] },
      { index: 2, role: 'assistant' as const, text: 'Parser pronto em csv-parser.ts', tools: ['write'] },
    ],
  })),
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

vi.mock('../chat-engine', () => ({ runChat: mocks.runChat, getRunningSessionIds: () => mocks.running }))
vi.mock('../companion-server', () => ({ broadcastSessionEvent: mocks.broadcastSessionEvent }))
vi.mock('../ask-dispatch', () => ({ dispatchAsk: mocks.dispatchAsk }))
vi.mock('../subchats', () => ({
  createSubchatRecord: mocks.createSubchatRecord,
  findSubchat: mocks.findSubchat,
  readSubchatMessages: mocks.readSubchatMessages,
}))

const { createSubchatTools } = await import('./subchats')
const { withWorkspaceLock } = await import('../session/workspace-lock')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const exec = (tools: ReturnType<typeof createSubchatTools>, name: 'suggest_subchat' | 'open_subchat' | 'read_subchat' | 'send_to_subchat') =>
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

  it('o turno do filho entra na fila da pasta em vez de herdar a trava do pai', async () => {
    // O filho é outra conversa na mesma pasta e não é esperado pelo pai:
    // herdando a trava, ele escreveria junto com o pai e seguiria depois que
    // o pai a soltasse, ao lado do próximo turno da fila.
    const order: string[] = []
    let filho: Promise<void> | undefined
    mocks.runChat.mockImplementationOnce(async (_win, child) => {
      filho = withWorkspaceLock(child.directory!, async () => {
        order.push('filho')
      })
      await filho
    })
    await withWorkspaceLock('/repo', async () => {
      await exec(createSubchatTools(input(), janela), 'open_subchat')({ title: 'Parser de CSV', brief: BRIEF }, {})
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('pai-saiu')
    })
    await filho
    expect(order).toEqual(['pai-saiu', 'filho'])
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

describe('send_to_subchat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.running.length = 0
  })

  it('dispara um turno no filho com a instrução, sem esperar a resposta', async () => {
    const r = await exec(createSubchatTools(input(), janela), 'send_to_subchat')(
      { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
      {},
    )
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    const [, filho] = mocks.runChat.mock.calls[0] as [unknown, SendMessageInput]
    expect(filho.sessionId).toBe('ses_filho')
    expect(filho.directory).toBe('/repo')
    // No chat do filho a mensagem diz de onde veio, na língua do usuário.
    expect(filho.text).toBe('Mensagem do chat principal: Agora cubra aspas escapadas')
    expect(String(r)).toContain('Instruction sent')
    // Não pergunta por conta própria: o card é o gate de permissão (rules.ts).
    expect(mocks.dispatchAsk).not.toHaveBeenCalled()
  })

  it('só instrui filho DESTA conversa', async () => {
    const r = await exec(createSubchatTools(input({ sessionId: 'ses_outra' }), janela), 'send_to_subchat')(
      { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
      {},
    )
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('No subchat')
  })

  it('recusa filho que ainda está rodando um turno', async () => {
    mocks.running.push('ses_filho')
    const r = await exec(createSubchatTools(input(), janela), 'send_to_subchat')(
      { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
      {},
    )
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('busy')
  })

  it('duas instruções no mesmo passo: a segunda recusa', async () => {
    const tools = createSubchatTools(input(), janela)
    const send = exec(tools, 'send_to_subchat')
    const args = { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' }
    const [a, b] = await Promise.all([send(args, {}), send(args, {})])
    expect(mocks.runChat).toHaveBeenCalledTimes(1)
    expect([String(a), String(b)].filter((t) => t.includes('busy'))).toHaveLength(1)
  })

  it('o turno do filho entra na fila da pasta em vez de herdar a trava do pai', async () => {
    const order: string[] = []
    let filho: Promise<void> | undefined
    mocks.runChat.mockImplementationOnce(async (_win, child) => {
      filho = withWorkspaceLock(child.directory!, async () => {
        order.push('filho')
      })
      await filho
    })
    await withWorkspaceLock('/repo', async () => {
      await exec(createSubchatTools(input(), janela), 'send_to_subchat')(
        { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
        {},
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('pai-saiu')
    })
    await filho
    expect(order).toEqual(['pai-saiu', 'filho'])
  })

  it('sem janela não dispara nada', async () => {
    const r = await exec(createSubchatTools(input()), 'send_to_subchat')(
      { subchatId: 'ses_filho', message: 'Agora cubra aspas escapadas' },
      {},
    )
    expect(mocks.runChat).not.toHaveBeenCalled()
    expect(String(r)).toContain('needs the app window')
  })
})

describe('read_subchat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.running.length = 0
  })

  it('devolve a conversa do filho com o status', async () => {
    mocks.running.push('ses_filho')
    const r = String(
      await exec(createSubchatTools(input(), janela), 'read_subchat')({ subchatId: 'ses_filho' }, {}),
    )
    expect(r).toContain('Parser de CSV')
    expect(r).toContain('running a turn now')
    expect(r).toContain('Parser pronto em csv-parser.ts')
    expect(r).toContain('[tools: write]')
    expect(mocks.runChat).not.toHaveBeenCalled()
  })

  it('id de outra conversa não lê nada', async () => {
    const r = await exec(createSubchatTools(input({ sessionId: 'ses_outra' }), janela), 'read_subchat')(
      { subchatId: 'ses_filho' },
      {},
    )
    expect(String(r)).toContain('No subchat')
    expect(mocks.readSubchatMessages).not.toHaveBeenCalled()
  })
})
