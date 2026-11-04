import { describe, expect, it, vi } from 'vitest'
import {
  MOTION_FPS,
  MOTION_RUNTIME,
  MOTION_RUNTIME_PATH,
  MOTION_SOURCE,
  injectMotionRuntime,
  motionRuntimeTag,
  parseMotionCommand,
  parseMotionMessage,
} from './motion-runtime'

const TAG = motionRuntimeTag('orbit-motion', 'mv_abc')

describe('MOTION_RUNTIME', () => {
  it('is valid JavaScript and carries the frozen frame contract', () => {
    // Compiles the text: a syntax error in the string would only show up in the render
    // window, with the user waiting for the video.
    expect(() => new Function(MOTION_RUNTIME)).not.toThrow()
    expect(MOTION_RUNTIME).toContain(`const FPS = ${MOTION_FPS}`)
    expect(MOTION_RUNTIME).toContain('window.orbitMotion')
    expect(MOTION_RUNTIME).toContain('delayRender')
    expect(MOTION_RUNTIME).toContain('postMessage')
    // Whole frame: the seek converts by fps.
    expect(MOTION_RUNTIME).toContain('frame / resolved.fps')
  })
})

describe('parseMotionCommand (host → iframe)', () => {
  it('accepts the four commands and normalizes the frame', () => {
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek', frame: 7.6 })).toEqual({ type: 'seek', frame: 8 })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek', frame: -3 })).toEqual({ type: 'seek', frame: 0 })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'play' })).toEqual({ type: 'play' })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'pause' })).toEqual({ type: 'pause' })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'loop', on: true })).toEqual({ type: 'loop', on: true })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'loop', on: false })).toEqual({ type: 'loop', on: false })
  })

  it('accepts the highlight: the element address, with the label to check', () => {
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'highlight', index: 12, name: '.caption' })).toEqual({
      type: 'highlight',
      index: 12,
      name: '.caption',
    })
    // The name is optional (it serves as a check, not as an address).
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'highlight', index: 12.4 })).toEqual({
      type: 'highlight',
      index: 12,
      name: null,
    })
    // Unmarking is a COMMAND (index -1), not its absence: without that the mark
    // would stay on screen until the next selection.
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'highlight', index: null })).toEqual({
      type: 'highlight',
      index: -1,
      name: null,
    })
  })

  it('rejects anything that is not one of ours', () => {
    expect(parseMotionCommand(null)).toBeNull()
    expect(parseMotionCommand('seek')).toBeNull()
    expect(parseMotionCommand({ type: 'seek', frame: 1 })).toBeNull() // no source
    expect(parseMotionCommand({ source: 'chat', type: 'seek', frame: 1 })).toBeNull()
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek' })).toBeNull()
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek', frame: Number.NaN })).toBeNull()
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek', frame: '3' })).toBeNull()
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'ready', durationInFrames: 10 })).toBeNull() // from the other side
  })
})

describe('parseMotionMessage (iframe → host)', () => {
  it('accepts ready/time/error/assets', () => {
    expect(
      parseMotionMessage({ source: MOTION_SOURCE, type: 'ready', durationInFrames: 120.4, width: 1920, height: 1080, fps: 60, version: 1 }),
    ).toEqual({
      type: 'ready',
      durationInFrames: 120,
      width: 1920,
      height: 1080,
      fps: 60,
      version: 1,
    })
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'time', frame: 12.9 })).toEqual({ type: 'time', frame: 13 })
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'error', message: 'boom', stack: 'at x' })).toEqual({
      type: 'error',
      message: 'boom',
      stack: 'at x',
    })
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'assets', failedFonts: ['Inter', 7, 'Geist'] })).toEqual({
      type: 'assets',
      failedFonts: ['Inter', 'Geist'],
    })
  })

  it('falls back to sensible defaults and rejects malformed messages', () => {
    // Without fps in the message (old runtime), the contract default counts: 30.
    const ready = parseMotionMessage({ source: MOTION_SOURCE, type: 'ready', durationInFrames: 90 })
    expect(ready).toEqual({ type: 'ready', durationInFrames: 90, width: 1920, height: 1080, fps: 30, version: 0 })
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'ready' })).toBeNull()
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'error', message: 42 })).toBeNull()
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'seek', frame: 1 })).toBeNull() // from the other side
    expect(parseMotionMessage({ source: 'chat', type: 'time', frame: 1 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The runtime runs ON the page. Here it runs against a minimal fake page, to
// lock down what would only show up in a real window: the whole frame, the wait
// for delayRender and the discarding of stale seeks.
// ---------------------------------------------------------------------------

interface FakeApi {
  seek(frame: number): Promise<void>
  delayRender(): number
  continueRender(handle: number): void
  durationInFrames?: number
  width?: number
  height?: number
  fps?: number
  version?: number
  failedFonts?: string[]
}

type FakeEvent = { data?: unknown; source?: unknown }
type FakeListener = (event: FakeEvent) => void

const tick = (times = 3) =>
  (async () => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })()

function makePage(
  options: {
    meta?: string | null
    predeclared?: Record<string, unknown>
    manual?: boolean
    /** Elements that `querySelector` finds, per selector. */
    elements?: Record<string, unknown>
    /** Lists that `querySelectorAll` returns, per selector (the <video>s, for example). */
    lists?: Record<string, unknown[]>
    /** More members of the fake document (createElement, body…). */
    doc?: Record<string, unknown>
  } = {},
) {
  const posted: Array<Record<string, unknown>> = []
  const writes: number[] = []
  const animation = {
    _t: 0,
    pause() {},
    get currentTime() {
      return this._t
    },
    set currentTime(value: number) {
      writes.push(value)
      this._t = value
    },
  }
  const listeners: FakeListener[] = []
  const parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) }
  const win = {
    devicePixelRatio: 2,
    parent,
    orbitMotion: (options.predeclared ?? {}) as Record<string, unknown>,
    addEventListener: (type: string, fn: FakeListener) => {
      if (type === 'message') listeners.push(fn)
    },
  }
  const doc = {
    readyState: 'complete',
    documentElement: { style: {} as Record<string, string>, getBoundingClientRect: () => ({ height: 1080 }) },
    querySelector: (selector: string) =>
      options.meta && selector.includes('orbit-motion')
        ? { getAttribute: () => options.meta }
        : (options.elements?.[selector] ?? null),
    querySelectorAll: (selector: string) => (options.lists?.[selector] ?? []) as unknown[],
    getAnimations: () => [animation],
    fonts: Object.assign([] as unknown[], { ready: Promise.resolve() }),
    ...(options.doc ?? {}),
  }
  // The play is a rAF loop with the performance clock: to look frame by
  // frame, the test controls both. In `manual` mode the callbacks stay in a
  // queue that the test drains and the clock is `clock`.
  const clock = { t: 0 }
  const queue: Array<() => void> = []
  const raf = options.manual
    ? (fn: () => void) => queue.push(fn)
    : (fn: () => void) => setTimeout(fn, 0) as unknown as number
  const caf = (id: number) => {
    if (!options.manual) clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
  }
  new Function(
    'window',
    'document',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'performance',
    'setTimeout',
    'clearTimeout',
    MOTION_RUNTIME,
  )(win, doc, raf, caf, { now: () => clock.t }, setTimeout, clearTimeout)

  return { win, parent, posted, writes, animation, listeners, clock, queue, api: win.orbitMotion as unknown as FakeApi }
}

type FakePage = ReturnType<typeof makePage>

/** Host command, as the runtime receives it (the same bridge as the preview). */
function send(page: FakePage, type: string, extra: Record<string, unknown> = {}): void {
  page.listeners[0]({ data: { source: MOTION_SOURCE, type, ...extra }, source: page.parent })
}

/** Frames that the play told to paint, in order. */
function timeFrames(page: FakePage): number[] {
  return page.posted.filter((m) => m.type === 'time').map((m) => m.frame as number)
}

/**
 * One step of play with the controlled clock: the clock advances `ms` and the pending
 * rAF callbacks run until a new frame is painted (it is what the runtime's rAF
 * batch does, counting on the seek's nextFrame ones).
 */
async function step(page: FakePage, ms: number): Promise<void> {
  const before = timeFrames(page).length
  page.clock.t += ms
  for (let i = 0; i < 20; i++) {
    const fn = page.queue.shift()
    if (!fn) break
    fn()
    await tick(1)
    if (timeFrames(page).length > before) return
  }
}

/** A document whose boxes lay text out with a simple model: every glyph is 0.5em wide, a line is 1.2em tall. */
function textLayoutDoc() {
  const body = { appendChild: () => {}, removeChild: () => {} }
  const createElement = () => {
    const box = {
      style: {} as Record<string, string>,
      textContent: '',
      get offsetWidth() {
        return this.metrics().width
      },
      get offsetHeight() {
        return this.metrics().height
      },
      get scrollWidth() {
        return this.metrics().scrollWidth
      },
      metrics() {
        const size = parseFloat(this.style.fontSize || '16')
        const glyph = size * 0.5
        const line = size * 1.2
        const text = this.textContent
        if (this.style.whiteSpace === 'nowrap') return { width: text.length * glyph, height: line, scrollWidth: text.length * glyph }
        const width = parseFloat(this.style.width)
        let lines = 1
        let used = 0
        let widest = 0
        for (const word of text.split(' ')) {
          const w = word.length * glyph
          widest = Math.max(widest, w)
          const next = used === 0 ? w : used + glyph + w
          if (next > width && used > 0) {
            lines++
            used = w
          } else used = next
        }
        return { width, height: lines * line, scrollWidth: Math.max(width, widest) }
      },
    }
    return box
  }
  return { body, createElement }
}

describe('orbitMotion.measureText / fitText in the page', () => {
  const api = () => makePage({ meta: 'fps=30,duration=2', doc: textLayoutDoc() }).api as unknown as Record<string, (...a: unknown[]) => any>

  it('measures a single line and a wrapped block', () => {
    const { measureText } = api()
    expect(measureText('EQUILIBRIO', { fontSize: 100 })).toMatchObject({ width: 500, height: 120, lines: 1 })
    const wrapped = measureText('um dois tres quatro', { fontSize: 20, maxWidth: 100 })
    expect(wrapped.lines).toBeGreaterThan(1)
    expect(wrapped.overflowX).toBe(false)
    expect(measureText('supercalifragilistic', { fontSize: 20, maxWidth: 100 }).overflowX).toBe(true)
  })

  it('finds the largest size that keeps one line inside the box', () => {
    const { fitText } = api()
    // 10 glyphs at 0.5em: 5 * size <= 952 -> 190
    expect(fitText('EQUILIBRIO', { maxWidth: 952 })).toMatchObject({ fontSize: 190, lines: 1, fits: true })
    expect(fitText('EQUILIBRIO', { maxWidth: 952, max: 104 }).fontSize).toBe(104)
  })

  it('fits on several lines and within a height', () => {
    const { fitText } = api()
    const two = fitText('um dois tres quatro cinco seis', { maxWidth: 200, maxLines: 2 })
    expect(two.lines).toBeLessThanOrEqual(2)
    expect(two.fits).toBe(true)
    const one = fitText('um dois tres quatro cinco seis', { maxWidth: 200, maxLines: 1 })
    expect(two.fontSize).toBeGreaterThan(one.fontSize)
    const tall = fitText('um dois tres quatro cinco seis', { maxWidth: 200, maxLines: 9, maxHeight: 60 })
    expect(tall.height).toBeLessThanOrEqual(60)
  })

  it('says fits: false (at the minimum size) when nothing fits, and asks for maxWidth', () => {
    const { fitText } = api()
    expect(fitText('supercalifragilistic', { maxWidth: 10, min: 12 })).toMatchObject({ fontSize: 12, fits: false })
    expect(() => fitText('x', {})).toThrow(/maxWidth/)
  })
})

describe('orbitMotion.scenes in the page', () => {
  const scenes = (api: unknown) => (api as { scenes: (l: unknown[], o?: unknown) => any }).scenes

  it('sets the length of the piece when the meta does not pin one (duration=auto)', () => {
    const { api, posted } = makePage({ meta: 'width=1080,height=1920,fps=30,duration=auto' })
    const S = scenes(api)([{ name: 'a', dur: 4 }, { name: 'b', dur: 2.5 }])
    expect(S.total).toBe(6.5)
    expect(api.durationInFrames).toBe(195)
    expect(posted.filter((m) => m.type === 'ready').pop()?.durationInFrames).toBe(195)
  })

  it('follows the scenes when they are laid out again (a duration was cut)', () => {
    const { api } = makePage({ meta: 'fps=30,duration=auto' })
    scenes(api)([{ name: 'a', dur: 4 }, { name: 'b', dur: 20 }])
    expect(api.durationInFrames).toBe(720)
    scenes(api)([{ name: 'a', dur: 4 }, { name: 'b', dur: 9.5 }])
    expect(api.durationInFrames).toBe(405)
  })

  it('leaves a length the piece pinned alone, and reports the scenes to the host', () => {
    const { api, win } = makePage({ meta: 'fps=30,duration=10' })
    scenes(api)([{ name: 'a', dur: 4 }, { name: 'b', dur: 20 }])
    expect(api.durationInFrames).toBe(300)
    const spec = (win as unknown as { __orbitMotionSpec: () => { scenes: unknown[] } }).__orbitMotionSpec()
    expect(spec.scenes).toEqual([{ name: 'a', start: 0, end: 4 }, { name: 'b', start: 4, end: 24 }])
  })
})

describe('orbitMotion.audio.words in the page', () => {
  it('reads the sidecar of each track of audio.json and answers on the piece clock', async () => {
    const files: Record<string, unknown> = {
      '/audio.json': { tracks: [{ file: 'nar.wav', name: 'Narração', start: 10 }, { file: 'base.mp3' }] },
      '/nar.wav.words.json': {
        words: [
          { text: 'Existe', startMs: 300, endMs: 800 },
          { text: 'humilde,', startMs: 900, endMs: 1500 },
        ],
      },
    }
    const g = globalThis as Record<string, unknown>
    const saved = { fetch: g.fetch, location: g.location }
    g.location = { href: 'http://orbit.test/index.html' }
    g.fetch = async (url: string) => {
      const body = files[new URL(url).pathname]
      return { ok: body !== undefined, json: async () => body }
    }
    try {
      const { api } = makePage({ meta: 'fps=30,duration=20' })
      const audio = (api as unknown as { audio: Record<string, (...a: unknown[]) => any> }).audio
      expect(audio.words()).toEqual([]) // the first call only starts the load…
      await tick(10)
      const words = audio.words()
      expect(words.map((w: { text: string }) => w.text)).toEqual(['Existe', 'humilde,'])
      expect(words[0].start).toBeCloseTo(10.3)
      expect(audio.words('Narração')).toHaveLength(2)
      expect(audio.words('nar.wav')).toHaveLength(2)
      expect(audio.find('humilde')).toBeCloseTo(10.9)
      expect(audio.wordAt(10.5)).toBe(0)
      expect(audio.lines()[0].text).toBe('Existe humilde,')
    } finally {
      g.fetch = saved.fetch
      g.location = saved.location
    }
  })
})

describe('MOTION_RUNTIME in the page', () => {
  it('anuncia o ready em QUADROS e o formato resolvido', () => {
    const { api, posted } = makePage({ meta: 'width=1080,height=1920,fps=30,duration=3' })
    expect(api.version).toBe(1)
    expect(api.width).toBe(1080)
    expect(api.height).toBe(1920)
    expect(api.durationInFrames).toBe(90)
    expect(posted).toContainEqual({
      source: MOTION_SOURCE,
      type: 'ready',
      durationInFrames: 90,
      width: 1080,
      height: 1920,
      fps: 30,
      version: 1,
    })
  })

  it('seek receives a FRAME and converts it to seconds in there', async () => {
    const { api, writes } = makePage({ meta: 'fps=30,duration=1' })
    await api.seek(15)
    expect(writes).toEqual([500]) // 15/30 s
  })

  it('waits for the open delayRender before applying the frame', async () => {
    const { api, writes } = makePage({ meta: 'fps=30,duration=1' })
    const handle = api.delayRender()
    const pending = api.seek(6)
    await tick()
    expect(writes).toEqual([]) // still waiting for the handle
    api.continueRender(handle)
    await pending
    expect(writes).toEqual([200])
  })

  it('blows up into an error instead of hanging when the handle is not released', async () => {
    vi.useFakeTimers()
    try {
      const { api } = makePage({ meta: 'fps=30,duration=1' })
      const handle = api.delayRender()
      const pending = api.seek(2)
      const outcome = expect(pending).rejects.toThrow(/delayRender/)
      await vi.advanceTimersByTimeAsync(10_000)
      await outcome
      api.continueRender(handle)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never queues overlapping seeks: the newest wins and the old one is dropped', async () => {
    const { api, writes } = makePage({ meta: 'fps=30,duration=1' })
    const handle = api.delayRender()
    const first = api.seek(1)
    const second = api.seek(2)
    api.continueRender(handle)
    await first
    await second
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBeCloseTo((2 / 30) * 1000, 2)
  })

  it('uses the composition seek (canvas etc.) passing the FRAME, without losing the API', async () => {
    const seen: number[] = []
    const { api, writes } = makePage({
      meta: 'fps=30,duration=1',
      predeclared: { seek: (frame: number) => void seen.push(frame) },
    })
    await api.seek(4)
    expect(seen).toEqual([4])
    // CSS animations/videos keep being fetched, like in the old render.
    expect(writes[0]).toBeCloseTo((4 / 30) * 1000, 2)
    expect(typeof api.delayRender).toBe('function')
  })

  it('applies a host command coming from the parent', async () => {
    const { listeners, writes, parent } = makePage({ meta: 'fps=30,duration=1' })
    expect(listeners).toHaveLength(1)
    listeners[0]({ data: { source: MOTION_SOURCE, type: 'seek', frame: 4 }, source: parent })
    await tick()
    expect(writes[0]).toBeCloseTo((4 / 30) * 1000, 2)

    // From another origin/unknown command, it ignores it.
    listeners[0]({ data: { source: 'chat', type: 'seek', frame: 9 }, source: parent })
    listeners[0]({ data: { source: MOTION_SOURCE, type: 'ready' }, source: parent })
    await tick()
    expect(writes).toHaveLength(1)
  })

  it('accepts the old window.orbitMotion = { … } declaration without erasing the API', async () => {
    const { win, api, posted } = makePage({})
    expect(api.durationInFrames).toBeUndefined()
    // The composition declares AFTER the runtime: it merges (the numbers enter the
    // API, delayRender/seek stay up) and ready comes out with the new size.
    win.orbitMotion = { duration: 2, fps: 30 }
    await tick(2)
    expect(api.durationInFrames).toBe(60)
    expect(typeof api.seek).toBe('function')
    expect(posted.some((m) => m.type === 'ready' && m.durationInFrames === 60)).toBe(true)
  })

  it('aceita o comprimento declarado em QUADROS (durationInFrames)', () => {
    // The new contract: the composition declares the length in frames, together with
    // the seek itself (it is the skeleton the motion skill teaches).
    const { api, posted } = makePage({
      predeclared: { width: 1920, height: 1080, fps: 30, durationInFrames: 120, seek: () => {} },
    })
    expect(api.durationInFrames).toBe(120)
    expect(posted).toContainEqual({
      source: MOTION_SOURCE,
      type: 'ready',
      durationInFrames: 120,
      width: 1920,
      height: 1080,
      fps: 30,
      version: 1,
    })
  })

  it('accepts durationInFrames assigned after the runtime', async () => {
    const { win, api } = makePage({ meta: 'fps=30' })
    expect(api.durationInFrames).toBeUndefined()
    win.orbitMotion.durationInFrames = 90
    await tick(2)
    expect(api.durationInFrames).toBe(90)
  })

  it('captures the seek the composition assigns after the runtime', async () => {
    const { win, api, writes } = makePage({ meta: 'fps=30,duration=1' })
    const seen: number[] = []
    win.orbitMotion.seek = (frame: number) => void seen.push(frame)
    expect(api.seek).not.toBe(writes) // the API keeps the runtime's seek
    await api.seek(9)
    expect(seen).toEqual([9])
  })
})

describe('runtime play (clock and rAF controlled by the test)', () => {
  // 3 frames at 30 fps: the end arrives fast and the last frame is the bug's case.
  const make3 = () => makePage({ meta: 'fps=30,duration=0.1', manual: true })

  it('with loop on, play wraps around instead of stopping on the last frame', async () => {
    const page = make3()
    send(page, 'loop', { on: true })
    send(page, 'play')
    await step(page, 1000 / 30)
    await step(page, 1000 / 30)
    // Reached the last frame (2) and did NOT stop: the next frame is already scheduled.
    expect(timeFrames(page)).toEqual([1, 2])
    await step(page, 1000 / 30)
    // Went past the end and came back to the start.
    expect(timeFrames(page)).toEqual([1, 2, 0])
    // And keeps going after the return.
    await step(page, 1000 / 30)
    expect(timeFrames(page)).toEqual([1, 2, 0, 1])
  })

  it('with no loop, it stops on the last frame and goes no further', async () => {
    const page = make3()
    send(page, 'play')
    for (let i = 0; i < 5; i++) await step(page, 1000 / 30)
    // Clamps to the last frame (not to a frame that does not exist) and pauses.
    expect(timeFrames(page)).toEqual([1, 2, 2])
    await step(page, 1000 / 30)
    expect(timeFrames(page)).toEqual([1, 2, 2])
  })

  it('pause to play', async () => {
    const page = make3()
    send(page, 'play')
    await step(page, 1000 / 30)
    send(page, 'pause')
    const before = timeFrames(page).length
    await step(page, 1000 / 30)
    expect(timeFrames(page)).toHaveLength(before)
  })
})

describe('injectMotionRuntime', () => {
  it('puts the runtime as the FIRST script of <head>', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><script src="gsap.min.js"></script></head><body></body></html>'
    const out = injectMotionRuntime(html, 'orbit-motion', 'mv_abc')
    expect(out).toContain(TAG)
    expect(out.indexOf(TAG)).toBeGreaterThan(out.indexOf('<head>'))
    expect(out.indexOf(TAG)).toBeLessThan(out.indexOf('<meta'))
    // The URL served by the scheme is the reserved path.
    expect(TAG).toContain(`orbit-motion://mv_abc${MOTION_RUNTIME_PATH}`)
  })

  it('handles a head with attributes and an uppercase tag', () => {
    const html = '<html><HEAD class="x"><title>t</title></HEAD><body></body></html>'
    const out = injectMotionRuntime(html, 'orbit-motion', 'mv_abc')
    expect(out.indexOf(TAG)).toBeGreaterThan(out.indexOf('<HEAD'))
    expect(out.indexOf(TAG)).toBeLessThan(out.indexOf('<title>'))
  })

  it('creates a head when there is none, and prefixes when not even <html> is there', () => {
    const withHtml = injectMotionRuntime('<html><body><h1>oi</h1></body></html>', 'orbit-motion', 'mv_abc')
    expect(withHtml).toContain(`<head>${TAG}`)
    const fragment = injectMotionRuntime('<div>oi</div>', 'orbit-motion', 'mv_abc')
    expect(fragment.startsWith(TAG)).toBe(true)
  })

  it('adds the import map for the native three.js right after the runtime', () => {
    const out = injectMotionRuntime('<head><script type="module">import * as THREE from "three"</script></head>', 'orbit-motion', 'mv_abc')
    expect(out).toContain('"three":"orbit-motion://mv_abc/__orbit-three/three.module.js"')
    expect(out).toContain('"three/addons/":"orbit-motion://mv_abc/__orbit-three/addons/"')
    expect(out.indexOf('importmap')).toBeLessThan(out.indexOf('type="module"'))
  })

  it('respects an import map the composition brings itself', () => {
    const html = '<head><script type="importmap">{"imports":{"three":"./three.js"}}</script></head>'
    expect(injectMotionRuntime(html, 'orbit-motion', 'mv_abc')).not.toContain('__orbit-three')
  })

  it('never injects twice', () => {
    const once = injectMotionRuntime('<head></head>', 'orbit-motion', 'mv_abc')
    expect(injectMotionRuntime(once, 'orbit-motion', 'mv_abc')).toBe(once)
  })
})

describe('orbitMotion.transition', () => {
  /** A fake element: stores every `animate()` and returns an animation that records the time. */
  function fakeElement(id?: string) {
    const calls: Array<{ frames: Array<Record<string, string>>; timing: Record<string, unknown> }> = []
    const animations: Array<{ paused: boolean; currentTime: number }> = []
    return {
      id,
      calls,
      animations,
      animate(frames: Array<Record<string, string>>, timing: Record<string, unknown>) {
        calls.push({ frames, timing })
        const animation = {
          paused: false,
          currentTime: 0,
          pause() {
            this.paused = true
          },
        }
        animations.push(animation)
        return animation
      },
    }
  }
  type TransitionApi = FakeApi & {
    transition(raw: Record<string, unknown>): Record<string, unknown>
    transitions: Array<Record<string, unknown>>
  }

  it('creates one paused animation per side, timed on the piece clock', () => {
    const a = fakeElement('scene-a')
    const b = fakeElement()
    const page = makePage({ meta: 'fps=30,duration=4', elements: { '.a': a, '.b': b } })
    const api = page.api as TransitionApi
    const done = api.transition({ out: '.a', in: '.b', at: 1.5, duration: 0.5, type: 'push', direction: 'up' })
    expect(done).toMatchObject({ end: 2, type: 'push', direction: 'up', out: '.a', in: '.b' })
    // The exit stays hidden AFTER the end; the entrance, BEFORE the start.
    expect(a.calls[0].timing).toEqual({ delay: 1500, duration: 500, easing: 'ease-in-out', fill: 'forwards' })
    expect(b.calls[0].timing).toEqual({ delay: 1500, duration: 500, easing: 'ease-in-out', fill: 'backwards' })
    expect(a.animations[0].paused).toBe(true)
    expect(b.animations[0].paused).toBe(true)
  })

  it('is seeked on every frame, even after it left document.getAnimations()', async () => {
    const a = fakeElement()
    const page = makePage({ meta: 'fps=30,duration=4', elements: { '.a': a } })
    ;(page.api as TransitionApi).transition({ out: '.a', at: 1, type: 'fade' })
    await page.api.seek(45)
    // The fake page only lists its own animation: the transition's is NOT in
    // document.getAnimations() (it is what happens with one that already ended) and even
    // so it is positioned — without that, going back in time would leave it stuck at the end.
    expect(page.writes).toEqual([1500])
    expect(a.animations[0].currentTime).toBe(1500)
    await page.api.seek(0)
    expect(a.animations[0].currentTime).toBe(0)
  })

  it('accepts an element and labels it by id or tag', () => {
    const a = fakeElement('scene-a')
    const api = makePage({ meta: 'fps=30,duration=4' }).api as TransitionApi
    api.transition({ out: a, at: 0 })
    expect(api.transitions).toEqual([
      { type: 'fade', direction: null, at: 0, duration: 0.6, out: '#scene-a', in: null },
    ])
  })

  it('throws, naming the selector, when nothing matches', () => {
    const api = makePage({ meta: 'fps=30,duration=4' }).api as TransitionApi
    expect(() => api.transition({ out: '.missing', at: 0 })).toThrow(/no element matches ".missing"/)
  })

  it('throws on a bad request and on the same element in both sides', () => {
    const a = fakeElement()
    const api = makePage({ meta: 'fps=30,duration=4', elements: { '.a': a } }).api as TransitionApi
    expect(() => api.transition({ out: '.a', at: 0, type: 'spin' })).toThrow(/unknown type/)
    expect(() => api.transition({ out: '.a', in: '.a', at: 0 })).toThrow(/same element/)
    expect(a.calls).toHaveLength(0)
  })

  it('announces what was registered in the spec snapshot the render and the lint read', () => {
    const page = makePage({ meta: 'fps=30,duration=4', elements: { '.a': fakeElement(), '.b': fakeElement() } })
    ;(page.api as TransitionApi).transition({ out: '.a', in: '.b', at: 1, type: 'wipe' })
    const spec = (page.win as unknown as { __orbitMotionSpec(): { transitions: unknown[] } }).__orbitMotionSpec()
    expect(spec.transitions).toEqual([
      { type: 'wipe', direction: 'left', at: 1, duration: 0.6, out: '.a', in: '.b' },
    ])
  })
})

describe('<video> in the page', () => {
  /** A fake <video>: stores every position the runtime asks for and answers `seeked`. */
  function fakeVideo(attrs: Record<string, string> = {}, over: { duration?: number; loop?: boolean } = {}) {
    const seen: number[] = []
    const video = {
      muted: false,
      duration: over.duration ?? 10,
      loop: over.loop ?? false,
      currentTime: 0,
      seen,
      pause() {},
      getAttribute: (name: string) => attrs[name] ?? null,
      hasAttribute: (name: string) => name in attrs,
      currentSrc: 'orbit-motion://mv_x/clip.mp4',
      addEventListener(_type: string, fn: () => void) {
        queueMicrotask(fn)
      },
    }
    Object.defineProperty(video, 'currentTime', {
      get: () => seen[seen.length - 1] ?? 0,
      set: (value: number) => {
        seen.push(value)
      },
    })
    return video
  }

  it('mutes the page video: its sound enters through the mix, not the window', () => {
    const v = fakeVideo()
    makePage({ meta: 'fps=30,duration=4', lists: { video: [v] } })
    expect(v.muted).toBe(true)
  })

  it('also mutes the video the page creates AFTER the runtime (the real case: the runtime is the first script)', async () => {
    const list: unknown[] = []
    const { api } = makePage({ meta: 'fps=30,duration=4', lists: { video: list } })
    const v = fakeVideo()
    list.push(v)
    expect(v.muted).toBe(false)
    await api.seek(3)
    expect(v.muted).toBe(true)
  })

  it('with no attributes the video moves with the piece time, as always', async () => {
    const v = fakeVideo()
    const { api } = makePage({ meta: 'fps=30,duration=4', lists: { video: [v] } })
    await api.seek(45)
    expect(v.seen).toEqual([1.5])
  })

  it('data-start, data-in and data-end rule the file position', async () => {
    const v = fakeVideo({ 'data-start': '1', 'data-in': '5', 'data-end': '2' })
    const { api } = makePage({ meta: 'fps=30,duration=4', lists: { video: [v] } })
    await api.seek(15) // 0.5 s: before the start → stopped at data-in
    await api.seek(60) // 2 s: 1 s after the start → 6
    await api.seek(105) // 3.5 s: past the data-end (2) → stuck at the same 6: nothing new to ask for
    expect(v.seen).toEqual([5, 6])
  })

  it('publishes the snapshot of the videos for the host to build the audio track', () => {
    const silent = fakeVideo({ muted: '' })
    const withSound = fakeVideo({ 'data-start': '2', 'data-in': '1', 'data-end': '6', 'data-gain': '-4' }, { loop: true })
    const optOut = fakeVideo({ 'data-audio': 'false' })
    const page = makePage({ meta: 'fps=30,duration=4', lists: { video: [silent, withSound, optOut] } })
    const spec = (page.win as unknown as { __orbitMotionSpec(): { videos: unknown[] } }).__orbitMotionSpec()
    expect(spec.videos).toEqual([
      { src: 'orbit-motion://mv_x/clip.mp4', muted: true, loop: false, gain: 0, start: 0, in: 0, end: undefined },
      { src: 'orbit-motion://mv_x/clip.mp4', muted: false, loop: true, gain: -4, start: 2, in: 1, end: 6 },
      { src: 'orbit-motion://mv_x/clip.mp4', muted: true, loop: false, gain: 0, start: 0, in: 0, end: undefined },
    ])
  })
})

describe('orbitMotion.camera', () => {
  type Layer = { style: Record<string, string>; attrs: Record<string, string>; tagName: string; getAttribute(n: string): string | null; getBoundingClientRect(): Record<string, number> }
  const layer = (depth?: string, rect = { left: 0, top: 0, width: 1080, height: 1920 }): Layer => ({
    style: {},
    attrs: depth ? { 'data-depth': depth } : {},
    tagName: 'DIV',
    getAttribute(n: string) {
      return this.attrs[n] ?? null
    },
    getBoundingClientRect: () => rect,
  })
  type CameraApi = FakeApi & { camera(o: Record<string, unknown>): CamCtl }
  type CamCtl = {
    move(m: Record<string, unknown>): CamCtl
    focus(t: unknown, m?: Record<string, unknown>): CamCtl
    zoomThrough(t: unknown, m?: Record<string, unknown>): CamCtl
    shake(s: Record<string, unknown>): CamCtl
    at(t: number): { x: number; y: number; zoom: number; rot: number }
    plan(): Array<{ at: number; to: { x: number; y: number; zoom: number } }>
  }
  const matrixOf = (el: Layer) => (el.style.transform.match(/matrix\((.*)\)/)![1].split(',').map(Number))

  function setup(layers: Layer[], extra: Record<string, unknown> = {}) {
    const world = { children: layers, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }) }
    const page = makePage({ meta: 'width=1080,height=1920,fps=30,duration=6', elements: { '#world': world, ...extra } })
    return { api: page.api as CameraApi, page }
  }

  it('moves the layers on every seek, on the piece clock (frame / fps)', async () => {
    const a = layer()
    const { api } = setup([a])
    api.camera({ world: '#world' }).move({ at: 1, dur: 1, style: 'linear', to: { zoom: 2 } })
    await api.seek(0)
    expect(matrixOf(a)[0]).toBeCloseTo(1, 6)
    await api.seek(45) // 1.5 s: halfway, geometrically sqrt(2)
    expect(matrixOf(a)[0]).toBeCloseTo(Math.SQRT2, 3)
    await api.seek(90) // 3 s: it stayed where it ended
    expect(matrixOf(a)[0]).toBeCloseTo(2, 6)
    expect(a.style.transformOrigin).toBe('0 0')
  })

  it('a layer with data-depth moves less than the world for the same pan', async () => {
    const near = layer()
    const far = layer('2')
    const { api } = setup([near, far])
    api.camera({ world: '#world' }).move({ at: 0, dur: 0.1, to: { x: 740 } })
    await api.seek(30)
    expect(-matrixOf(near)[4] + 0).toBeCloseTo(200, 3)
    expect(-matrixOf(far)[4]).toBeCloseTo(100, 3)
  })

  it('focus frames an element measured in the world, and zoomThrough fills the frame with it', async () => {
    const a = layer()
    const target = layer(undefined, { left: 100, top: 200, width: 400, height: 200 })
    const { api } = setup([a], { '#hero': target })
    const cam = api.camera({ world: '#world' })
    cam.focus('#hero', { at: 0, dur: 1 })
    cam.zoomThrough('#hero', { at: 2, dur: 1 })
    await api.seek(0)
    const plan = cam.plan()
    expect(plan[0].to).toMatchObject({ x: 300, y: 300 })
    expect(plan[0].to.zoom).toBeCloseTo(2.7, 6)
    expect(plan[1].to.zoom).toBeCloseTo(9.6 * 1.02, 6)
  })

  it('explains itself when the world or the target is missing, or the target has no size', () => {
    const { api } = setup([layer()])
    expect(() => api.camera({ world: '#nope' })).toThrow(/world not found/)
    const cam = api.camera({ world: '#world' })
    cam.focus('#ghost', { at: 0 })
    expect(() => cam.plan()).toThrow(/focus target not found/)
  })

  it('shake adds to the camera only inside its window', async () => {
    const { api } = setup([layer()])
    const cam = api.camera({ world: '#world' }).shake({ at: 1, dur: 0.5, amp: 30 })
    expect(cam.at(0.5)).toMatchObject({ x: 540, y: 960 })
    expect(cam.at(1.1).x).not.toBe(540)
    expect(cam.at(3)).toMatchObject({ x: 540, y: 960 })
  })
})
