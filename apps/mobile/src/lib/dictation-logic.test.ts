import { describe, expect, it } from 'vitest'
import {
  dictationReducer,
  insertTranscript,
  levelsStale,
  pcmLevel,
  pushLevel,
  visibleLevels,
  voiceLanguage,
  type DictationPhase,
} from './dictation-logic'

function pcm(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  samples.forEach((s, i) => view.setInt16(i * 2, s, true))
  return out
}

describe('dictationReducer', () => {
  it('walks idle → starting → recording → transcribing → idle', () => {
    let p: DictationPhase = 'idle'
    p = dictationReducer(p, { type: 'press' })
    expect(p).toBe('starting')
    p = dictationReducer(p, { type: 'started' })
    expect(p).toBe('recording')
    p = dictationReducer(p, { type: 'press' })
    expect(p).toBe('transcribing')
    p = dictationReducer(p, { type: 'finished' })
    expect(p).toBe('idle')
  })
  it('ignores presses while starting or transcribing', () => {
    expect(dictationReducer('starting', { type: 'press' })).toBe('starting')
    expect(dictationReducer('transcribing', { type: 'press' })).toBe('transcribing')
  })
  it('returns to idle when the start fails', () => {
    expect(dictationReducer('starting', { type: 'startFailed' })).toBe('idle')
  })
  it('cancel always lands on idle, even mid-transcription', () => {
    for (const p of ['idle', 'starting', 'recording', 'transcribing'] as const) {
      expect(dictationReducer(p, { type: 'cancel' })).toBe('idle')
    }
  })
  it('a late "started" after cancel does not resurrect the recording', () => {
    expect(dictationReducer('idle', { type: 'started' })).toBe('idle')
  })
})

describe('pcmLevel', () => {
  it('is 0 for silence and empty input', () => {
    expect(pcmLevel(pcm([0, 0, 0, 0]))).toBe(0)
    expect(pcmLevel(new Uint8Array(0))).toBe(0)
  })
  it('grows with loudness and caps at 1', () => {
    const quiet = pcmLevel(pcm(new Array(64).fill(300)))
    const loud = pcmLevel(pcm(new Array(64).fill(12000)))
    expect(quiet).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(quiet)
    expect(pcmLevel(pcm(new Array(64).fill(32767)))).toBe(1)
  })
  it('reads negative samples and honours byteOffset', () => {
    const base = pcm([0, 0, -12000, -12000])
    expect(pcmLevel(base.subarray(4))).toBeGreaterThan(0.5)
  })
})

describe('levels buffer', () => {
  it('pushLevel keeps the newest max', () => {
    const v: number[] = []
    for (let i = 1; i <= 5; i++) pushLevel(v, i, 3)
    expect(v).toEqual([3, 4, 5])
  })
  it('visibleLevels pads on the left', () => {
    expect(visibleLevels([0.5, 0.7], 4)).toEqual([0, 0, 0.5, 0.7])
    expect(visibleLevels([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5])
  })
  it('levelsStale flags missing metering', () => {
    expect(levelsStale(1000, 1300)).toBe(false)
    expect(levelsStale(1000, 2000)).toBe(true)
  })
})

describe('voiceLanguage', () => {
  it('maps app locales to engine codes', () => {
    expect(voiceLanguage('pt-BR')).toBe('pt')
    expect(voiceLanguage('en')).toBe('en')
    expect(voiceLanguage('en_US')).toBe('en')
    expect(voiceLanguage(undefined)).toBeUndefined()
    expect(voiceLanguage('')).toBeUndefined()
  })
})

describe('insertTranscript', () => {
  it('appends to the end without a selection', () => {
    expect(insertTranscript('hello', ' world ')).toEqual({ text: 'hello world', cursor: 11 })
  })
  it('fills an empty field', () => {
    expect(insertTranscript('', 'hi')).toEqual({ text: 'hi', cursor: 2 })
  })
  it('inserts at the cursor keeping both sides', () => {
    expect(insertTranscript('fix the bug', 'login', { start: 8, end: 8 })).toEqual({
      text: 'fix the login bug',
      cursor: 14,
    })
  })
  it('does not double spaces already present', () => {
    expect(insertTranscript('a  c', 'b', { start: 2, end: 2 })).toEqual({ text: 'a b c', cursor: 3 })
    expect(insertTranscript('a\n', 'b', { start: 2, end: 2 }).text).toBe('a\nb')
  })
  it('replaces a selected range', () => {
    expect(insertTranscript('say XXX now', 'hello', { start: 4, end: 7 }).text).toBe('say hello now')
  })
  it('clamps a stale selection beyond the text', () => {
    expect(insertTranscript('abc', 'd', { start: 99, end: 99 }).text).toBe('abc d')
  })
  it('keeps the text when the transcript is blank', () => {
    expect(insertTranscript('abc', '   ', { start: 1, end: 1 })).toEqual({ text: 'abc', cursor: 1 })
  })
})
