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
  store.set('session/other', worker('other', 'other-orch'))
  store.set('messages/w1', [
    msg('m1', 'user', 'implemente a API', T0, 'orchestrator'),
    msg('m2', 'assistant', 'API ready', T0 + 10),
    msg('m3', 'user', 'change the port to 4000', T0 + 100),
    msg('m4', 'assistant', 'port changed', T0 + 110),
  ])
  // An old worker, without the origin mark: the first message is the task prompt.
  // The review comes marked STRUCTURALLY — never through the message text.
  store.set('messages/w2', [
    msg('n1', 'user', 'faça a tela', T0),
    msg('n2', 'assistant', 'screen done', T0 + 10),
    msg('n3', 'user', 'the button is missing', T0 + 20, 'orchestrator'),
    msg('n4', 'assistant', 'button included', T0 + 30),
  ])
}

const exec = (t: unknown, args: unknown) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(args, {})

describe('orchestrator workers', () => {
  it('lists only the workers of this conversation', async () => {
    seed()
    expect((await loadWorkers('orq')).map((w) => w.id)).toEqual(['w1', 'w2'])
  })

  it('the notice points only at what the user typed directly after the last turn', async () => {
    seed()
    const notice = await buildWorkersNotice('orq', T0 + 50)
    expect(notice).toContain('workerId: w1')
    expect(notice).toContain('change the port to 4000')
    // An orchestrator review does not count as a user message
    expect(notice).not.toContain('the button is missing')
    expect(await buildWorkersNotice('orq', T0 + 200)).not.toContain('⚠')
    expect(await buildWorkersNotice('nobody', 0)).toBe('')
  })

  it('read_worker identifies who wrote each message', async () => {
    seed()
    const tools = createWorkerTools('orq', vi.fn())
    const out = await exec(tools.read_worker, { workerId: 'w1' })
    expect(out).toContain('#1 you (orchestrator)')
    expect(out).toContain('#3 USER (typed directly)')
    expect(await exec(tools.read_worker, { workerId: 'other' })).toContain('No worker')
  })

  it('message_worker continues the worker and refuses when it is busy', async () => {
    seed()
    const run = vi.fn(async () => ({ text: 'done' }))
    const tools = createWorkerTools('orq', run)
    expect(await exec(tools.message_worker, { workerId: 'w1', message: 'add tests' })).toContain('done')
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' }), 'add tests')

    running.push('w2')
    expect(await exec(tools.message_worker, { workerId: 'w2', message: 'x' })).toContain('busy')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
