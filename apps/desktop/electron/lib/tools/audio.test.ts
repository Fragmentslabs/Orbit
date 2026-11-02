import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-audio-tool-test' },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  BrowserWindow: class {},
  ipcMain: { handle: () => {} },
  net: { fetch: () => {} },
  session: {},
}))

const { captionCues, clock } = await import('./audio')

describe('duration clock', () => {
  it('clock in m:ss, with hours only when needed', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65_400)).toBe('1:05')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(clock(5_000, true)).toBe('0:00:05')
  })
})

describe('caption cues', () => {
  const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs })

  it('a line closes at punctuation and at a pause, with the real times of its words', () => {
    const cues = captionCues([
      w('Orgulho', 0, 500), w('mata,', 520, 900), w('diz', 950, 1100), w('ele', 1120, 1300),
      w('Depois', 2000, 2400), w('vem', 2420, 2600), w('a', 2610, 2650), w('humildade.', 2660, 3300),
    ])
    expect(cues).toEqual([
      { startMs: 0, endMs: 900, text: 'Orgulho mata,' },
      { startMs: 950, endMs: 1300, text: 'diz ele' },
      { startMs: 2000, endMs: 3300, text: 'Depois vem a humildade.' },
    ])
  })

  it('a long run without pauses is split into short lines', () => {
    const words = Array.from({ length: 10 }, (_, i) => w(`p${i}`, i * 200, i * 200 + 180))
    expect(captionCues(words).map((c) => c.text.split(' ').length)).toEqual([7, 3])
  })
})
