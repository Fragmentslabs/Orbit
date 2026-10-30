import { describe, expect, it } from 'vitest'
import type { TimedWord } from './edl'
import { silencesIn } from './timeline'

const w = (text: string, startMs: number, endMs: number): TimedWord => ({ text, startMs, endMs })

describe('silencesIn', () => {
  it('with no transcript it declares no silence at all', () => {
    // Music/ambience have no transcription: empty `words` is not a
    // 9 s pause, it is the absence of a measurement — the video with a track was reported entirely
    // as silence.
    expect(silencesIn([], 0, 9200)).toEqual([])
  })

  it('finds the gaps between two speeches, including at the window edges', () => {
    const words = [w('a', 1000, 1500), w('b', 3000, 3400)]
    expect(silencesIn(words, 0, 4000)).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 1500, endMs: 3000 },
      { startMs: 3400, endMs: 4000 },
    ])
  })

  it('ignores a gap smaller than the minimum', () => {
    const words = [w('a', 1000, 1500), w('b', 1800, 2000)]
    expect(silencesIn(words, 1000, 2000, 400)).toEqual([])
  })

  it('a window inside a speech has no silence', () => {
    const words = [w('longa', 0, 5000)]
    expect(silencesIn(words, 1000, 2000, 400)).toEqual([])
  })
})
