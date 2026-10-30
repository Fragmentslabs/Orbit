/**
 * The motion player on the phone.
 *
 * What is verified here is the contract with the page, which is what makes the piece
 * move: the probe that asks for the duration, the `seek` in FRAMES (the unit of the
 * runtime), the play clock deriving the frame from the time, the loop and the
 * degradation when the page does not answer or refuses the seek.
 *
 * What is NOT verified: dragging the ruler. In jsdom there is no layout (the width
 * of the track is 0 through `onLayout`), so the gesture has no geometry to become a
 * frame — the calculation it does, `frameAtX`, is tested directly.
 */
import type { PieceRef } from '@orbit/shared'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MotionViewer,
  formatTime,
  frameAtX,
  resolveSpec,
} from './motion'

// The real WebView is native: here it becomes an inert host that delivers
// `onLoadEnd`, stores the props (to simulate the page answers) and records
// the `injectJavaScript` the player uses.
const harness = vi.hoisted(() => ({
  inject: vi.fn(),
  web: { current: null as Record<string, any> | null },
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const { View } = await import('react-native')
  const WebView = React.forwardRef<unknown, Record<string, any>>(function WebViewStub(props, ref) {
    harness.web.current = props
    React.useImperativeHandle(ref, () => ({ injectJavaScript: harness.inject }))
    return React.createElement(View, { testID: props.testID })
  })
  return { __esModule: true, WebView, default: WebView }
})

// The labels are the keys: the test does not depend on the i18n bundle.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}))

// Icons: the drawing is not what is verified. `Repeat` is not in the global mock
// (test-env) — the list here is the player's plus the one of `PieceView`.
vi.mock('lucide-react-native', () => {
  const names = ['AlertCircle', 'Maximize2', 'Pause', 'Play', 'Repeat', 'RotateCw', 'X']
  const icons: Record<string, unknown> = { __esModule: true }
  for (const name of names) icons[name] = () => null
  return icons
})

const SOURCE = 'orbit-motion-player'
const URL_PIECE = 'http://192.168.0.2:7777/api/file/motion/mv_ab12/tok'

const PIECE: PieceRef = {
  kind: 'motion',
  id: 'mv_ab12',
  url: URL_PIECE,
  title: 'Intro',
}

/** The 3 s piece at 30 fps from the example: 90 frames. */
const SPEC = {
  source: SOURCE,
  type: 'spec',
  fps: 30,
  durationInFrames: 90,
  width: 1920,
  height: 1080,
  seek: true,
}

/** Frames of every injected `seek`, in order. */
function seeks(): number[] {
  const frames: number[] = []
  for (const call of harness.inject.mock.calls as unknown[][]) {
    const match = /api\.seek\((\d+)\)/.exec(String(call[0] ?? ''))
    if (match) frames.push(Number(match[1]))
  }
  return frames
}

function lastSeek(): number | undefined {
  const frames = seeks()
  return frames[frames.length - 1]
}

function injectionsMatching(pattern: RegExp): string[] {
  return (harness.inject.mock.calls as unknown[][])
    .map((call) => String(call[0] ?? ''))
    .filter((js) => pattern.test(js))
}

/** The page finished loading. */
function load() {
  act(() => {
    harness.web.current?.onLoadEnd?.()
  })
}

/** The page spoke (postMessage → onMessage). */
function reply(payload: Record<string, unknown>) {
  act(() => {
    harness.web.current?.onMessage?.({ nativeEvent: { data: JSON.stringify(payload) } })
  })
}

function renderPlayer(piece: PieceRef = PIECE) {
  return render(<MotionViewer piece={piece} />)
}

function timeLabel(): string {
  return screen.getByTestId('motion-time').textContent ?? ''
}

beforeEach(() => {
  // jsdom has no window: without this `useWindowDimensions` returns 0x0 and the stage
  // has no width to fit the piece (the `zoom` test would fall into the void).
  // `visualViewport` is where react-native-web reads the size from, and the resize
  // event is what makes it read again.
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { width: 390, height: 844, scale: 1 },
  })
  window.dispatchEvent(new Event('resize'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  harness.inject.mockClear()
  harness.web.current = null
})

describe('page contract (pure)', () => {
  it('the duration in frames is canonical and beats the duration in seconds', () => {
    const spec = resolveSpec({ fps: 30, durationInFrames: 90, duration: 10, metaDuration: 4 })
    expect(spec).toEqual({ fps: 30, frames: 90, width: 1920, height: 1080, seekable: false })
  })

  it('without frames, the seconds become frames with the resolved fps (api > meta > 30)', () => {
    expect(resolveSpec({ fps: 60, duration: 2 })?.frames).toBe(120)
    expect(resolveSpec({ metaFps: 24, metaDuration: 2 })?.frames).toBe(48)
    expect(resolveSpec({ duration: 2 })?.frames).toBe(60)
  })

  it('the GSAP timeline and piece.count come last, in runtime order', () => {
    expect(resolveSpec({ timeline: 1.5 })?.frames).toBe(45)
    expect(resolveSpec({ metaDuration: 2 }, 10)?.frames).toBe(60)
    expect(resolveSpec({}, 4)?.frames).toBe(120)
  })

  it('with no length at all it returns null — it does not invent a duration', () => {
    expect(resolveSpec({ fps: 30 })).toBeNull()
    expect(resolveSpec({ duration: 0, timeline: 0, metaDuration: 0 }, 0)).toBeNull()
  })

  it('the document size falls back to 1920x1080 as in the runtime', () => {
    const spec = resolveSpec({ durationInFrames: 10, metaWidth: 1080, metaHeight: 1080 })
    expect(spec?.width).toBe(1080)
    expect(spec?.height).toBe(1080)
  })

  it('the time is m:ss, with two-digit seconds', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(3.9)).toBe('0:04')
    expect(formatTime(2.966)).toBe('0:03')
    expect(formatTime(61)).toBe('1:01')
    expect(formatTime(Number.NaN)).toBe('0:00')
    expect(formatTime(-2)).toBe('0:00')
  })

  it('o x da trilha vira quadro inteiro, preso ao intervalo', () => {
    expect(frameAtX(0, 300, 90)).toBe(0)
    expect(frameAtX(150, 300, 90)).toBe(45)
    expect(frameAtX(300, 300, 90)).toBe(89)
    expect(frameAtX(-40, 300, 90)).toBe(0)
    expect(frameAtX(900, 300, 90)).toBe(89)
    expect(frameAtX(100, 0, 90)).toBe(0)
  })
})

describe('motion on the phone', () => {
  it('the piece is loaded from the URL the desktop signed', () => {
    renderPlayer()
    expect(screen.getByTestId('piece-view')).toBeTruthy()
    expect(harness.web.current?.source).toEqual({ uri: URL_PIECE })
    // Nothing is injected before the page exists.
    expect(harness.inject).not.toHaveBeenCalled()
  })

  it('on load, it probes the format and seeks to frame 0', () => {
    renderPlayer()
    load()

    const [probe] = injectionsMatching(/durationInFrames/).slice(0, 1)
    expect(probe).toContain(SOURCE)
    expect(probe).toContain('meta[name="orbit-motion"]')
    expect(lastSeek()).toBe(0)
  })

  it('the duration comes from the page and the time shows as 0:00 / 0:03', () => {
    renderPlayer()
    load()
    reply(SPEC)

    expect(timeLabel()).toBe('0:00 / 0:03')
    // The ruler speaks in frames, the same unit as `seek`.
    const track = screen.getByTestId('motion-track')
    expect(track.getAttribute('aria-valuemax')).toBe('89')
    expect(track.getAttribute('aria-valuenow')).toBe('0')
    expect(track.getAttribute('aria-valuetext')).toBe('0:00 / 0:03')
  })

  it('the piece is fitted to the stage (the composition is a 1920x1080 document)', () => {
    renderPlayer()
    load()
    reply(SPEC)

    const [fit] = injectionsMatching(/style\.zoom/).reverse().slice(0, 1)
    expect(fit).toBeDefined()
    const scale = Number(/zoom = '([\d.]+)'/.exec(fit ?? '')?.[1])
    expect(scale).toBeGreaterThan(0)
    expect(scale).toBeLessThan(1)
  })

  it('playing sends one seek per frame and advances the time', () => {
    vi.useFakeTimers()
    renderPlayer()
    load()
    reply(SPEC)

    fireEvent.click(screen.getByTestId('motion-play'))
    expect(screen.getByLabelText('pieces.motion.pause')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(1100)
    })

    // 1100 ms at 30 fps: the screen clock has already passed frame 30.
    expect(lastSeek()).toBeGreaterThanOrEqual(30)
    expect(timeLabel()).toBe('0:01 / 0:03')
  })

  it('stopping in the middle freezes where it was', () => {
    vi.useFakeTimers()
    renderPlayer()
    load()
    reply(SPEC)

    fireEvent.click(screen.getByTestId('motion-play'))
    act(() => {
      vi.advanceTimersByTime(700)
    })
    fireEvent.click(screen.getByLabelText('pieces.motion.pause'))
    const frozen = lastSeek()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(lastSeek()).toBe(frozen)
    expect(screen.getByLabelText('pieces.motion.play')).toBeTruthy()
  })

  it('with loop on, the end goes back to the start', () => {
    vi.useFakeTimers()
    renderPlayer()
    load()
    reply(SPEC)

    fireEvent.click(screen.getByTestId('motion-play'))
    act(() => {
      // 4 s on a 3 s piece: it went past the end and started over.
      vi.advanceTimersByTime(4000)
    })

    expect(lastSeek()).toBeLessThan(90)
    expect(screen.getByLabelText('pieces.motion.pause')).toBeTruthy()
  })

  it('without loop, it stops on the last frame', () => {
    vi.useFakeTimers()
    renderPlayer()
    load()
    reply(SPEC)

    fireEvent.click(screen.getByTestId('motion-loop'))
    fireEvent.click(screen.getByTestId('motion-play'))
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(lastSeek()).toBe(89)
    expect(timeLabel()).toBe('0:03 / 0:03')
    expect(screen.getByLabelText('pieces.motion.play')).toBeTruthy()
  })

  it('a page that answers with no length at all: controls off', () => {
    renderPlayer()
    load()
    reply({ source: SOURCE, type: 'spec', fps: 30, seek: true })

    expect(timeLabel()).toBe('0:00 / –:–')
    fireEvent.click(screen.getByTestId('motion-play'))
    expect(seeks().filter((frame) => frame > 0)).toEqual([])
  })

  it('a piece with no seek on the page: shows the duration and does not pretend it plays', () => {
    renderPlayer()
    load()
    reply({ ...SPEC, seek: false })

    expect(timeLabel()).toBe('0:00 / 0:03')
    fireEvent.click(screen.getByTestId('motion-play'))
    expect(seeks().filter((frame) => frame > 0)).toEqual([])
  })

  it('a seek that throws on the page turns the control off', () => {
    renderPlayer()
    load()
    reply(SPEC)

    reply({ source: SOURCE, type: 'error', message: 'boom' })
    fireEvent.click(screen.getByTestId('motion-play'))
    expect(seeks().filter((frame) => frame > 0)).toEqual([])
  })

  it('a message from another origin touches nothing', () => {
    renderPlayer()
    load()
    reply({ source: 'any-other', type: 'spec', durationInFrames: 90, seek: true })

    expect(timeLabel()).toBe('0:00 / –:–')
  })

  it('piece.count is the last resort when the page declares no duration', () => {
    renderPlayer({ ...PIECE, count: 4 })
    load()
    reply({ source: SOURCE, type: 'spec', fps: 30, seek: true })

    expect(timeLabel()).toBe('0:00 / 0:04')
  })
})
