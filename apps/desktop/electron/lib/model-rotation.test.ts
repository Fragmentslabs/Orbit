import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessagePart } from '@shared/chat'

/**
 * `companion-http` imports electron (app, BrowserWindow) and brings up a server —
 * none of that exists here. The only point model-rotation uses from it is the
 * per-session model cache, so that is what the mock exposes.
 */
const sessionModelsCache = vi.hoisted(() => ({ current: {} as Record<string, { providerId: string; modelId: string }> }))

vi.mock('./companion-http', () => ({
  getSessionModelsCache: () => sessionModelsCache.current,
}))

const {
  MAX_ROTATION_ATTEMPTS,
  RETRY_DELAYS_MS,
  hasStreamedContent,
  resolveRotation,
  retryDelay,
  selectNext,
  setRotationConfigCache,
  waitUnlessAborted,
} = await import('./model-rotation')

const model = (id: string) => ({ providerId: 'openai', modelId: id })
const fallback = model('fallback')

beforeEach(() => {
  sessionModelsCache.current = {}
  setRotationConfigCache({ rotations: [], sessionOverrides: {} })
})

describe('resolveRotation', () => {
  it('without rotation and without a pinned model, uses the model the renderer resolved', () => {
    expect(resolveRotation('s1', fallback)).toEqual([fallback])
  })

  it('a model pinned in the chat beats the global fallback', () => {
    sessionModelsCache.current = { s1: model('pinned') }
    expect(resolveRotation('s1', fallback)).toEqual([model('pinned')])
  })

  it('the rotation chosen in the chat beats the pinned model', () => {
    // The precedence matters: the engine resolves the rotation BEFORE the pin, so
    // choosing a model has to clear the chat's rotation (it is what the selector
    // does in both apps). If this flips, the chosen model does not count.
    sessionModelsCache.current = { s1: model('pinned') }
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models: [model('a'), model('b')] }],
      sessionOverrides: { s1: 'r1' },
    })
    expect(resolveRotation('s1', fallback)).toEqual([model('a'), model('b')])
  })

  it('the rotation applies only to the chat that chose it', () => {
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models: [model('a')] }],
      sessionOverrides: { s1: 'r1' },
    })
    expect(resolveRotation('s2', fallback)).toEqual([fallback])
  })

  it('a new chat (no sessionId) uses the draft key', () => {
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models: [model('a')] }],
      sessionOverrides: { draft: 'r1' },
    })
    expect(resolveRotation(undefined, fallback)).toEqual([model('a')])
  })

  it('cuts the sequence at the attempt ceiling', () => {
    const models = ['a', 'b', 'c', 'd'].map(model)
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models }],
      sessionOverrides: { s1: 'r1' },
    })
    const seq = resolveRotation('s1', fallback)
    expect(seq).toHaveLength(MAX_ROTATION_ATTEMPTS)
    expect(seq).toEqual(models.slice(0, MAX_ROTATION_ATTEMPTS))
  })

  it('an empty rotation falls back to normal behavior instead of an empty sequence', () => {
    // A freshly created rotation, still without a slot, cannot zero the turn's
    // sequence — it would be a chat that simply does not answer.
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models: [] }],
      sessionOverrides: { s1: 'r1' },
    })
    expect(resolveRotation('s1', fallback)).toEqual([fallback])
  })

  it('a choice pointing to a removed rotation falls back to normal behavior', () => {
    setRotationConfigCache({ rotations: [], sessionOverrides: { s1: 'sumiu' } })
    expect(resolveRotation('s1', fallback)).toEqual([fallback])
  })

  it('a cleared cache (null) does not break the resolution', () => {
    setRotationConfigCache(null)
    expect(resolveRotation('s1', fallback)).toEqual([fallback])
  })
})

describe('selectNext', () => {
  it('walks the sequence and returns undefined when exhausted', () => {
    const seq = [model('a'), model('b')]
    expect(selectNext(seq, 0)).toEqual(model('a'))
    expect(selectNext(seq, 1)).toEqual(model('b'))
    expect(selectNext(seq, 2)).toBeUndefined()
  })
})

describe('hasStreamedContent', () => {
  const text = (value: string): MessagePart => ({ type: 'text', id: 't1', state: 'done', text: value })
  const reasoning = (value: string): MessagePart =>
    ({ type: 'reasoning', id: 'r1', state: 'done', text: value }) as MessagePart
  const tool = (): MessagePart => ({ type: 'tool', tool: 'read', state: 'done' }) as MessagePart

  // v1 only rotates BEFORE the first output token: resending a turn that
  // already delivered content would charge the tokens again.
  it('a turn still without output may rotate', () => {
    expect(hasStreamedContent([])).toBe(false)
    expect(hasStreamedContent([text('')])).toBe(false)
  })

  it('text, reasoning or tool already emitted lock the rotation', () => {
    expect(hasStreamedContent([text('hi')])).toBe(true)
    expect(hasStreamedContent([reasoning('thinking')])).toBe(true)
    expect(hasStreamedContent([tool()])).toBe(true)
  })
})

describe('extra rounds of the turn', () => {
  it('the wait grows on every round and stops at the last step', () => {
    expect(retryDelay(1)).toBe(RETRY_DELAYS_MS[0])
    expect(retryDelay(2)).toBe(RETRY_DELAYS_MS[1])
    expect(retryDelay(3)).toBe(RETRY_DELAYS_MS[2])
    expect(retryDelay(9)).toBe(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])
  })

  it('stopping the turn cuts the wait immediately', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      let done = false
      const wait = waitUnlessAborted(30_000, controller.signal).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(done).toBe(false)
      controller.abort()
      await wait
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
