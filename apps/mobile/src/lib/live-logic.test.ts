import { describe, expect, it } from 'vitest'
import type { LiveState } from '@orbit/shared'
import {
  elapsedLabel,
  feedNewestFirst,
  frameAspect,
  hostLabel,
  isBusy,
  mergeLiveState,
  nextPollDelay,
  POLL_BUSY_MS,
  POLL_IDLE_MS,
} from './live-logic'

const state = (over: Partial<LiveState> = {}): LiveState => ({
  sessionId: 's', kind: 'browser', active: true, url: null, title: null, app: null,
  action: null, startedAt: 0, lastAt: 1000, frameRev: 1, feed: [], ...over,
})

describe('nextPollDelay', () => {
  it('does not poll a closed surface or a hidden screen', () => {
    expect(nextPollDelay({ state: state({ active: false }), now: 1000, failures: 0, visible: true })).toBeNull()
    expect(nextPollDelay({ state: state(), now: 1000, failures: 0, visible: false })).toBeNull()
    expect(nextPollDelay({ state: null, now: 1000, failures: 0, visible: true })).toBeNull()
  })
  it('is fast while busy, slower when idle', () => {
    expect(nextPollDelay({ state: state(), now: 2000, failures: 0, visible: true })).toBe(POLL_BUSY_MS)
    expect(nextPollDelay({ state: state(), now: 60_000, failures: 0, visible: true })).toBe(POLL_IDLE_MS)
  })
  it('backs off on failures up to a cap', () => {
    const d = (failures: number) => nextPollDelay({ state: state(), now: 2000, failures, visible: true })!
    expect(d(1)).toBeLessThan(d(2))
    expect(d(2)).toBeLessThan(d(3))
    expect(d(50)).toBe(d(4))
  })
})

describe('isBusy', () => {
  it('is true only for an active, recent surface', () => {
    expect(isBusy(state(), 2000)).toBe(true)
    expect(isBusy(state(), 100_000)).toBe(false)
    expect(isBusy(state({ active: false }), 2000)).toBe(false)
    expect(isBusy(null, 0)).toBe(false)
  })
})

describe('mergeLiveState', () => {
  const act = (id: number) => ({ id, at: id, label: `a${id}` })
  it('merges the event tail into the known ring by id', () => {
    const prev = state({ feed: [act(1), act(2), act(3)], lastAt: 10 })
    const next = state({ feed: [act(3), act(4)], lastAt: 20, frameRev: 2 })
    expect(mergeLiveState(prev, next).feed.map((a) => a.id)).toEqual([1, 2, 3, 4])
  })
  it('ignores a stale event', () => {
    const prev = state({ lastAt: 50, frameRev: 5, feed: [act(5)] })
    expect(mergeLiveState(prev, state({ lastAt: 10, frameRev: 2 }))).toBe(prev)
  })
  it('takes the first state as is', () => {
    const first = state()
    expect(mergeLiveState(undefined, first)).toBe(first)
  })
})

describe('labels', () => {
  it('shows host and path for the address bar', () => {
    expect(hostLabel('https://example.com/')).toBe('example.com')
    expect(hostLabel('https://example.com/docs/a')).toBe('example.com/docs/a')
    expect(hostLabel('not a url')).toBe('not a url')
    expect(hostLabel(null)).toBe('')
  })
  it('formats elapsed time', () => {
    expect(elapsedLabel(0, 42_000)).toBe('') // 0 = no start
    expect(elapsedLabel(1000, 43_000)).toBe('42s')
    expect(elapsedLabel(1000, 1000 + 185_000)).toBe('3m05s')
    expect(elapsedLabel(null, 5)).toBe('')
  })
  it('orders the feed newest first without mutating it', () => {
    const feed = [{ id: 1, at: 1, label: 'a' }, { id: 2, at: 2, label: 'b' }]
    expect(feedNewestFirst(feed).map((a) => a.id)).toEqual([2, 1])
    expect(feed[0].id).toBe(1)
  })
  it('bounds the frame aspect ratio', () => {
    expect(frameAspect(null)).toBeCloseTo(1.6)
    expect(frameAspect({ width: 1000, height: 500 })).toBe(2)
    expect(frameAspect({ width: 100, height: 1000 })).toBe(0.55)
  })
})
