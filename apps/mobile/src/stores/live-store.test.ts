import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveState } from '@orbit/shared'

import { selectActiveSurfaces, useLiveStore } from './live-store'

const http = { liveList: vi.fn(), liveFrame: vi.fn(), liveStop: vi.fn() }
vi.mock('./connection-store', () => ({ useConnectionStore: { getState: () => ({ http }) } }))

const st = (over: Partial<LiveState> = {}): LiveState => ({
  sessionId: 's1', kind: 'browser', active: true, url: 'https://a.com', title: 'A', app: null,
  action: 'Click', startedAt: 1, lastAt: 100, frameRev: 1, feed: [{ id: 1, at: 1, label: 'Click' }], ...over,
})

beforeEach(() => {
  useLiveStore.getState().reset()
  vi.clearAllMocks()
})

describe('live store', () => {
  it('keeps events per surface and exposes the active ones of a chat', () => {
    useLiveStore.getState().applyEvent(st())
    useLiveStore.getState().applyEvent(st({ kind: 'computer', app: 'Notes' }))
    useLiveStore.getState().applyEvent(st({ sessionId: 's2' }))
    const list = selectActiveSurfaces(useLiveStore.getState().states, 's1')
    expect(list.map((x) => x.kind)).toEqual(['computer', 'browser'])
    expect(selectActiveSurfaces(useLiveStore.getState().states, undefined)).toEqual([])
  })

  it('drops the frame when the surface closes but keeps the feed', async () => {
    http.liveFrame.mockResolvedValue({ ok: true, data: { rev: 1, state: st(), dataUrl: 'data:x', width: 10, height: 5, marker: null } })
    useLiveStore.getState().applyEvent(st())
    await useLiveStore.getState().fetchFrame('s1', 'browser')
    expect(useLiveStore.getState().frames['browser:s1']).toBeDefined()
    useLiveStore.getState().applyEvent(st({ active: false, lastAt: 200 }))
    expect(useLiveStore.getState().frames['browser:s1']).toBeUndefined()
    expect(useLiveStore.getState().status['browser:s1']).toBe('closed')
    expect(useLiveStore.getState().states['browser:s1'].feed).toHaveLength(1)
  })

  it('sends the held revision and keeps the frame on "unchanged"', async () => {
    http.liveFrame.mockResolvedValueOnce({ ok: true, data: { rev: 3, state: st({ frameRev: 3 }), dataUrl: 'data:x', width: 10, height: 5, marker: null } })
    await useLiveStore.getState().fetchFrame('s1', 'browser')
    http.liveFrame.mockResolvedValueOnce({ ok: true, data: { unchanged: true, rev: 3, state: st({ frameRev: 3 }) } })
    await useLiveStore.getState().fetchFrame('s1', 'browser')
    expect(http.liveFrame).toHaveBeenLastCalledWith('s1', 'browser', 3)
    expect(useLiveStore.getState().frames['browser:s1'].dataUrl).toBe('data:x')
  })

  it('drops a pull while one is in flight', async () => {
    let release!: (v: unknown) => void
    http.liveFrame.mockReturnValueOnce(new Promise((r) => (release = r)))
    const first = useLiveStore.getState().fetchFrame('s1', 'browser')
    await useLiveStore.getState().fetchFrame('s1', 'browser')
    expect(http.liveFrame).toHaveBeenCalledTimes(1)
    release({ ok: false })
    expect(await first).toBe(false)
  })

  it('counts failures and resets them on success', async () => {
    http.liveFrame.mockResolvedValueOnce({ ok: false, error: 'x' })
    expect(await useLiveStore.getState().fetchFrame('s1', 'browser')).toBe(false)
    expect(useLiveStore.getState().failures['browser:s1']).toBe(1)
    expect(useLiveStore.getState().status['browser:s1']).toBe('error')
    http.liveFrame.mockResolvedValueOnce({ ok: true, data: { unavailable: true, reason: 'no-frame', rev: 0, state: st({ frameRev: 0 }) } })
    expect(await useLiveStore.getState().fetchFrame('s1', 'browser')).toBe(true)
    expect(useLiveStore.getState().failures['browser:s1']).toBe(0)
    expect(useLiveStore.getState().status['browser:s1']).toBe('no-frame')
  })

  it('hydrate marks surfaces the desktop no longer lists as closed', async () => {
    useLiveStore.getState().applyEvent(st())
    http.liveList.mockResolvedValue({ ok: true, data: { sessions: [st({ sessionId: 's9' })] } })
    await useLiveStore.getState().hydrate()
    const { states } = useLiveStore.getState()
    expect(states['browser:s1'].active).toBe(false)
    expect(states['browser:s9'].active).toBe(true)
  })

  it('stop reports whether the desktop actually stopped something', async () => {
    http.liveStop.mockResolvedValue({ ok: true, data: { stopped: true } })
    expect(await useLiveStore.getState().stop('s1', 'computer')).toBe(true)
    http.liveStop.mockResolvedValue({ ok: true, data: { stopped: false } })
    expect(await useLiveStore.getState().stop('s1', 'computer')).toBe(false)
  })
})
