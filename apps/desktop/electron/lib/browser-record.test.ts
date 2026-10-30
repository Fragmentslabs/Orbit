import { describe, expect, it, vi } from 'vitest'

/**
 * Recording timeline: frames with a timestamp → concat durations.
 *
 * It is the count that defines the whole video: starting at the first frame (no
 * white loading screen), each frame lasting until the next one, and a still
 * stretch holding the last image for the real time it lasted. The rest of the module
 * depends on Electron and is exercised by the smoke test, not here.
 */

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  BrowserWindow: class {},
}))

const { frameTimeline, timelineDurationMs, concatList } = await import('./browser-record')

describe('frameTimeline', () => {
  it('starts at the first frame and lasts until the next one', () => {
    const entries = frameTimeline(
      [
        { file: 'a.jpg', at: 1000 },
        { file: 'b.jpg', at: 1033 },
        { file: 'c.jpg', at: 1066 },
      ],
      { endedAt: 1066 },
    )
    expect(entries.map((e) => e.durationMs)).toEqual([33, 33, 1])
    expect(timelineDurationMs(entries)).toBe(67)
  })

  it('keeps the last frame for the still time plus the tail', () => {
    const entries = frameTimeline(
      [
        { file: 'a.jpg', at: 0 },
        { file: 'b.jpg', at: 40 },
      ],
      { endedAt: 2000, tailMs: 500 },
    )
    expect(entries[1]).toEqual({ file: 'b.jpg', durationMs: 2460 })
  })

  it('sorts by timestamp and never generates zero duration', () => {
    const entries = frameTimeline(
      [
        { file: 'b.jpg', at: 50 },
        { file: 'a.jpg', at: 10 },
      ],
      { endedAt: 50 },
    )
    expect(entries[0]).toEqual({ file: 'a.jpg', durationMs: 40 })
    expect(entries.every((e) => e.durationMs >= 1)).toBe(true)
  })

  it('without frames, there is no timeline', () => {
    expect(frameTimeline([], { endedAt: 999 })).toEqual([])
  })

  it('the concat repeats the last file (otherwise ffmpeg drops its duration)', () => {
    const text = concatList([
      { file: '/tmp/a.jpg', durationMs: 33 },
      { file: '/tmp/b.jpg', durationMs: 500 },
    ])
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('ffconcat version 1.0')
    expect(lines[1]).toBe("file '/tmp/a.jpg'")
    expect(lines[2]).toBe('duration 0.0330')
    expect(lines[3]).toBe("file '/tmp/b.jpg'")
    expect(lines[4]).toBe('duration 0.5000')
    expect(lines[5]).toBe("file '/tmp/b.jpg'")
  })

  it('escapes the apostrophe in the path', () => {
    expect(concatList([{ file: "/tmp/o'brien.jpg", durationMs: 10 }])).toContain("file '/tmp/o'\\''brien.jpg'")
  })
})
