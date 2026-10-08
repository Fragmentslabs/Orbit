import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'

const store = new Map<string, unknown>()
const running: string[] = []

vi.mock('../storage', () => ({
  readJson: vi.fn(async (key: string) => store.get(key) ?? null),
  listKeys: vi.fn(async (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix))),
}))
vi.mock('../chat-engine', () => ({ getRunningSessionIds: () => running }))

const { buildWorkersNotice, createWorkerTools, loadWorkers } = await import('./workers')

const T0 = 1_000_000

function worker(id: string, parent: string, title = id): SessionInfo {
  return {
    id,
    title,
    mode: 'code',
    pinned: false,
    archived: false,
    folderId: null,
    orchestration: { role: 'worker', parentSessionId: parent, task: title },
    parentId: parent,
    createdAt: T0,
    updatedAt: T0,
  }
}

function msg(id: string, role: 'user' | 'assistant', text: string, createdAt: number, origin?: 'orchestrator'): ChatMessage {
  return { id, role, parts: [{ id: `${id}-p`, type: 'text', text, state: 'done' }], createdAt, origin }
}

function seed() {
  store.clear()
  running.length = 0
  store.set('session/w1', worker('w1', 'orq', 'Backend'))
  store.set('session/w2', worker('w2', 'orq', 'Frontend'))
  store.set('session/outro', worker('outro', 'outra-orq'))
  store.set('messages/w1', [
    msg('m1', 'user', 'implemente a API', T0, 'orchestrator'),
    msg('m2', 'assistant', 'API pronta', T0 + 10),
    msg('m3', 'user', 'troque a porta para 4000', T0 + 100),
    msg('m4', 'assistant', 'porta trocada', T0 + 110),
  ])
  // Worker antigo, sem a marca origin: a primeira mensagem e a de revisão são do orquestrador.
  store.set('messages/w2', [
    msg('n1', 'user', 'faça a tela', T0),
    msg('n2', 'assistant', 'tela feita', T0 + 10),
    msg('n3', 'user', '[Revisão 1] faltou o botão', T0 + 20),
    msg('n4', 'assistant', 'botão incluído', T0 + 30),
  ])
}

const exec = (t: unknown, args: unknown) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(args, {})

describe('workers do orquestrador', () => {
  it('lista só os workers desta conversa', async () => {
    seed()
    expect((await loadWorkers('orq')).map((w) => w.id)).toEqual(['w1', 'w2'])
  })

  it('o aviso aponta só o que o usuário digitou direto depois do último turno', async () => {
    seed()
    const notice = await buildWorkersNotice('orq', T0 + 50)
    expect(notice).toContain('workerId: w1')
    expect(notice).toContain('troque a porta para 4000')
    // Revisão antiga sem marca não conta como mensagem do usuário
    expect(notice).not.toContain('faltou o botão')
    expect(await buildWorkersNotice('orq', T0 + 200)).not.toContain('⚠')
    expect(await buildWorkersNotice('ninguem', 0)).toBe('')
  })

  it('read_worker identifica quem escreveu cada mensagem', async () => {
    seed()
    const tools = createWorkerTools('orq', vi.fn())
    const out = await exec(tools.read_worker, { workerId: 'w1' })
    expect(out).toContain('#1 you (orchestrator)')
    expect(out).toContain('#3 USER (typed directly)')
    expect(await exec(tools.read_worker, { workerId: 'outro' })).toContain('No worker')
  })

  it('message_worker continua o worker e recusa quando ele está ocupado', async () => {
    seed()
    const run = vi.fn(async () => ({ text: 'feito' }))
    const tools = createWorkerTools('orq', run)
    expect(await exec(tools.message_worker, { workerId: 'w1', message: 'adicione testes' })).toContain('feito')
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' }), 'adicione testes')

    running.push('w2')
    expect(await exec(tools.message_worker, { workerId: 'w2', message: 'x' })).toContain('busy')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
