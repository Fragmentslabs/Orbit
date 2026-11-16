import { describe, expect, it, vi } from 'vitest'
import type { LiveState } from '@shared/live'
import {
  createLiveThrottle,
  fitFrameSize,
  liveFrameRequest,
  liveListRequest,
  liveStopRequest,
  LiveRegistry,
  type LiveDeps,
} from './companion-live-core'

function setup(frame: Awaited<ReturnType<LiveDeps['captureFrame']>> = { dataUrl: 'data:image/jpeg;base64,AA', width: 10, height: 5, marker: null }) {
  let t = 1000
  const registry = new LiveRegistry(() => t++)
  const stop = vi.fn()
  const captureFrame = vi.fn(async () => frame)
  const deps: LiveDeps = { registry, captureFrame, stop }
  return { registry, deps, stop, captureFrame }
}

describe('LiveRegistry', () => {
  it('opens on the first action and exposes it as the current action', () => {
    const { registry } = setup()
    registry.action('browser', 's1', 'Navigate to example.com')
    const state = registry.state('browser', 's1')!
    expect(state.active).toBe(true)
    expect(state.action).toBe('Navigate to example.com')
    expect(state.feed.map((f) => f.label)).toEqual(['Navigate to example.com'])
    expect(state.startedAt).not.toBeNull()
  })

  it('collapses consecutive duplicate actions but keeps distinct ones in order', () => {
    const { registry } = setup()
    registry.action('browser', 's1', 'Read page')
    registry.action('browser', 's1', 'Read page')
    registry.action('browser', 's1', 'Click')
    registry.action('browser', 's1', 'Read page')
    expect(registry.state('browser', 's1')!.feed.map((f) => f.label)).toEqual(['Read page', 'Click', 'Read page'])
    const ids = registry.state('browser', 's1')!.feed.map((f) => f.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })

  it('caps the feed and sends only a short tail in events', () => {
    const { registry } = setup()
    const events: LiveState[] = []
    registry.subscribe((s) => events.push(s))
    for (let i = 0; i < 60; i++) registry.action('computer', 's1', `step ${i}`)
    expect(registry.state('computer', 's1')!.feed).toHaveLength(40)
    expect(events.at(-1)!.feed).toHaveLength(6)
    expect(events.at(-1)!.action).toBe('step 59')
  })

  it('close keeps the feed but leaves the active list', () => {
    const { registry } = setup()
    registry.action('browser', 's1', 'Click')
    registry.close('browser', 's1')
    expect(registry.listActive()).toEqual([])
    expect(registry.state('browser', 's1')!.feed).toHaveLength(1)
    expect(registry.state('browser', 's1')!.active).toBe(false)
  })

  it('keeps browser and computer of the same chat apart', () => {
    const { registry } = setup()
    registry.action('browser', 's1', 'a')
    registry.open('computer', 's1', { app: 'Notes' })
    expect(registry.listActive().map((s) => s.kind).sort()).toEqual(['browser', 'computer'])
  })

  it('update only emits when metadata really changed', () => {
    const { registry } = setup()
    const listener = vi.fn()
    registry.action('browser', 's1', 'a')
    registry.subscribe(listener)
    registry.update('browser', 's1', { url: 'https://a.com', title: 'A' })
    registry.update('browser', 's1', { url: 'https://a.com', title: 'A' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('frame bumps the revision', () => {
    const { registry } = setup()
    registry.action('browser', 's1', 'a')
    const before = registry.state('browser', 's1')!.frameRev
    registry.frame('browser', 's1')
    expect(registry.state('browser', 's1')!.frameRev).toBe(before + 1)
  })
})

describe('createLiveThrottle', () => {
  const state = (action: string, active = true): LiveState => ({
    sessionId: 's1', kind: 'browser', active, url: null, title: null, app: null, action,
    startedAt: 1, lastAt: 1, frameRev: 1, feed: [],
  })

  it('sends the first immediately and the newest of a burst once the window passes', () => {
    let now = 0
    const queue: (() => void)[] = []
    const send = vi.fn()
    const push = createLiveThrottle(send, 500, (fn) => queue.push(fn), () => now)
    push(state('a'))
    push(state('b'))
    push(state('c'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(queue).toHaveLength(1)
    now = 500
    queue.shift()!()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].action).toBe('c')
  })

  it('never delays a close', () => {
    let now = 0
    const send = vi.fn()
    const push = createLiveThrottle(send, 500, () => undefined, () => now)
    push(state('a'))
    now = 10
    push(state('a', false))
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('fitFrameSize', () => {
  it('downsizes by the longest edge keeping the ratio', () => {
    expect(fitFrameSize(1440, 900, 720)).toEqual({ width: 720, height: 450 })
    expect(fitFrameSize(390, 1560, 720)).toEqual({ width: 180, height: 720 })
  })
  it('never upscales', () => {
    expect(fitFrameSize(300, 200, 720)).toEqual({ width: 300, height: 200 })
  })
})

describe('liveFrameRequest', () => {
  it('validates the query', async () => {
    const { deps } = setup()
    expect((await liveFrameRequest(deps, { sessionId: 's1', kind: 'tablet' })).status).toBe(400)
    expect((await liveFrameRequest(deps, { kind: 'browser' })).status).toBe(400)
  })

  it('404s for a surface that never existed', async () => {
    const { deps } = setup()
    expect((await liveFrameRequest(deps, { sessionId: 'nope', kind: 'browser' })).status).toBe(404)
  })

  it('returns the frame with the state and revision', async () => {
    const { deps, registry } = setup()
    registry.action('browser', 's1', 'a')
    registry.frame('browser', 's1')
    const { status, body } = await liveFrameRequest(deps, { sessionId: 's1', kind: 'browser', since: '0' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ dataUrl: expect.stringContaining('data:image/jpeg'), rev: registry.state('browser', 's1')!.frameRev })
  })

  it('skips the capture when the phone already has the revision (frame dropping)', async () => {
    const { deps, registry, captureFrame } = setup()
    registry.action('browser', 's1', 'a')
    registry.frame('browser', 's1')
    const rev = registry.state('browser', 's1')!.frameRev
    const { body } = await liveFrameRequest(deps, { sessionId: 's1', kind: 'browser', since: String(rev) })
    expect(body).toMatchObject({ unchanged: true, rev })
    expect(captureFrame).not.toHaveBeenCalled()
  })

  it('reports closed, no-frame and capture failures instead of erroring', async () => {
    const closed = setup()
    closed.registry.action('browser', 's1', 'a')
    closed.registry.close('browser', 's1')
    expect((await liveFrameRequest(closed.deps, { sessionId: 's1', kind: 'browser' })).body).toMatchObject({ unavailable: true, reason: 'closed' })

    const none = setup(null)
    none.registry.action('browser', 's1', 'a')
    expect((await liveFrameRequest(none.deps, { sessionId: 's1', kind: 'browser' })).body).toMatchObject({ reason: 'no-frame' })

    const boom = setup()
    boom.registry.action('browser', 's1', 'a')
    boom.captureFrame.mockRejectedValueOnce(new Error('x'))
    expect((await liveFrameRequest(boom.deps, { sessionId: 's1', kind: 'browser' })).body).toMatchObject({ reason: 'capture-failed' })
  })
})

describe('liveStopRequest / liveListRequest', () => {
  it('stops only an active surface', () => {
    const { deps, registry, stop } = setup()
    expect(liveStopRequest(deps, { sessionId: 's1', kind: 'computer' }).body).toEqual({ stopped: false })
    registry.open('computer', 's1', { app: 'Notes' })
    expect(liveStopRequest(deps, { sessionId: 's1', kind: 'computer' }).body).toEqual({ stopped: true })
    expect(stop).toHaveBeenCalledWith('computer', 's1')
  })

  it('rejects bad bodies', () => {
    const { deps } = setup()
    expect(liveStopRequest(deps, { sessionId: 1, kind: 'computer' }).status).toBe(400)
    expect(liveStopRequest(deps, { sessionId: 's1', kind: 'x' }).status).toBe(400)
  })

  it('lists active surfaces', () => {
    const { deps, registry } = setup()
    registry.action('browser', 's1', 'a')
    registry.open('computer', 's2', {})
    registry.close('computer', 's2')
    expect((liveListRequest(deps).body as { sessions: LiveState[] }).sessions.map((s) => s.sessionId)).toEqual(['s1'])
  })
})
