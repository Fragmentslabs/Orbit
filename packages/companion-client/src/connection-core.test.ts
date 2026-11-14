import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionCore, type CoreOptions, type CoreSocket, type SocketEvents } from './connection-core'
import { backoffDelay } from './backoff'

class FakeSocket implements CoreSocket {
  sent: { id: string; payload: { type: string; [k: string]: unknown } }[] = []
  open = false
  closed = false
  constructor(public events: SocketEvents) {}
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
    this.open = false
  }
  isOpen() {
    return this.open
  }
  isConnecting() {
    return !this.open && !this.closed
  }
  // test helpers
  accept() {
    this.open = true
    this.events.open()
  }
  push(payload: object) {
    this.events.message(JSON.stringify({ id: '', payload }))
  }
  authOk() {
    this.events.message(JSON.stringify({ type: 'auth-ok' }))
  }
  drop(code = 1006) {
    this.open = false
    this.events.close(code)
  }
}

function setup(over: Partial<CoreOptions> = {}, extraHooks: Partial<CoreOptions['hooks']> = {}) {
  const sockets: FakeSocket[] = []
  const statuses: string[] = []
  const attempts: number[] = []
  const gaveUp = vi.fn()
  const events: unknown[] = []
  const core = new ConnectionCore({
    openSocket: (ev) => {
      const s = new FakeSocket(ev)
      sockets.push(s)
      return s
    },
    handshake: {
      start: (send) => send(JSON.stringify({ id: 'h', payload: { type: 'auth' } })),
      onMessage: (msg) => {
        const t = (msg as { type?: string }).type
        return t === 'auth-ok' ? { kind: 'ok' } : t === 'auth-no' ? { kind: 'rejected' } : { kind: 'ignore' }
      },
    },
    backoff: { baseMs: 1000, maxMs: 8000, maxAttempts: Infinity },
    heartbeat: { intervalMs: 15_000, pongTimeoutMs: 8_000, aliveCheckMs: 4_000 },
    requestTimeoutMs: 20_000,
    queueTimeoutMs: 15_000,
    resetAttemptsOn: 'connected',
    hooks: {
      onStatus: (s) => statuses.push(s),
      onAttempt: (n) => attempts.push(n),
      onConnected: () => {},
      onRejected: () => {},
      onGiveUp: gaveUp,
      onOpenError: () => {},
      onPong: () => {},
      onEvent: (p) => events.push(p),
      ...extraHooks,
    },
    ...over,
  })
  const last = () => sockets[sockets.length - 1]
  const connect = () => {
    core.start()
    last().accept()
    last().authOk()
  }
  return { core, sockets, statuses, attempts, gaveUp, events, last, connect }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('backoff', () => {
  it('doubles up to the ceiling', () => {
    const p = { baseMs: 1000, maxMs: 8000, maxAttempts: Infinity }
    expect([0, 1, 2, 3, 4, 10].map((n) => backoffDelay(n, p))).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
  })

  it('never gives up with an infinite policy, and reconnects with growing delays', () => {
    const t = setup()
    t.core.start()
    for (let i = 0; i < 20; i++) {
      t.last().drop()
      vi.advanceTimersByTime(8000)
    }
    expect(t.sockets.length).toBe(21)
    expect(t.gaveUp).not.toHaveBeenCalled()
  })

  it('gives up after maxAttempts and checkAlive starts over', () => {
    const t = setup({ backoff: { baseMs: 1000, maxMs: 8000, maxAttempts: 2 } })
    t.core.start()
    for (let i = 0; i < 3; i++) {
      t.last().drop()
      vi.advanceTimersByTime(8000)
    }
    expect(t.gaveUp).toHaveBeenCalledTimes(1)
    expect(t.core.getStatus()).toBe('disconnected')
    const before = t.sockets.length
    t.core.checkAlive()
    expect(t.sockets.length).toBe(before + 1)
  })
})

describe('liveness', () => {
  it('drops a socket that stays silent after a ping and reconnects', () => {
    const t = setup()
    t.connect()
    const first = t.last()
    vi.advanceTimersByTime(15_000)
    expect(first.sent[first.sent.length - 1]?.payload.type).toBe('ping')
    vi.advanceTimersByTime(8_000)
    expect(first.closed).toBe(true)
    expect(t.sockets.length).toBe(2)
  })

  it('keeps a socket that answers anything within the deadline', () => {
    const t = setup()
    t.connect()
    vi.advanceTimersByTime(15_000)
    vi.advanceTimersByTime(3_000)
    t.last().push({ type: 'pong' })
    vi.advanceTimersByTime(10_000)
    expect(t.sockets.length).toBe(1)
    expect(t.core.isOnline()).toBe(true)
  })

  it('checkAlive uses the short deadline', () => {
    const t = setup()
    t.connect()
    vi.advanceTimersByTime(1)
    t.core.checkAlive()
    vi.advanceTimersByTime(4_000)
    expect(t.sockets.length).toBe(2)
  })
})

describe('requests', () => {
  it('queues while offline, flushes in order on connect, and correlates responses', async () => {
    const t = setup()
    const a = t.core.request({ type: 'a' })
    const b = t.core.request({ type: 'b' })
    t.connect()
    const sent = t.last().sent.filter((m) => m.payload.type === 'a' || m.payload.type === 'b')
    expect(sent.map((m) => m.payload.type)).toEqual(['a', 'b'])
    t.last().push({ type: 'api:response', requestId: sent[1].id, ok: true, data: 2 })
    t.last().push({ type: 'api:response', requestId: sent[0].id, ok: true, data: 1 })
    expect((await a).data).toBe(1)
    expect((await b).data).toBe(2)
  })

  it('rejects a queued request after the 15s deadline', async () => {
    const t = setup()
    const p = t.core.request({ type: 'x' })
    const assertion = expect(p).rejects.toThrow('timed out (offline)')
    vi.advanceTimersByTime(15_001)
    await assertion
  })

  it('fails what was in flight when the socket drops', async () => {
    const t = setup()
    t.connect()
    const p = t.core.request({ type: 'x' })
    const assertion = expect(p).rejects.toThrow('Connection closed')
    t.last().drop()
    await assertion
  })

  it('times out an in-flight request without a response', async () => {
    const t = setup()
    t.connect()
    const p = t.core.request({ type: 'x' })
    const assertion = expect(p).rejects.toThrow('timed out')
    vi.advanceTimersByTime(20_001)
    await assertion
  })
})

describe('handshake', () => {
  it('stops reconnecting when rejected, and checkAlive does not resurrect it', () => {
    const t = setup()
    t.core.start()
    t.last().accept()
    t.last().events.message(JSON.stringify({ type: 'auth-no' }))
    expect(t.core.getStatus()).toBe('disconnected')
    vi.advanceTimersByTime(60_000)
    t.core.checkAlive()
    expect(t.sockets.length).toBe(1)
  })

  it('halt() from onSocketClosed vetoes the reconnect', () => {
    const t = setup({}, { onSocketClosed: (code) => code === 4001 && t.core.halt() })
    t.core.start()
    t.last().accept()
    t.last().drop(4001)
    vi.advanceTimersByTime(60_000)
    expect(t.sockets.length).toBe(1)
  })

  it('ignores late events of a replaced socket', () => {
    const t = setup()
    t.connect()
    const old = t.last()
    t.core.start()
    old.drop()
    vi.advanceTimersByTime(60_000)
    expect(t.sockets.length).toBe(2)
  })
})
