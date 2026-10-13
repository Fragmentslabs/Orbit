import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))

const { packTranscript, phrasesOf } = await import('./transcript')
const { tokensToWords } = await import('../voice/parakeet')

const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs })

describe('phrasesOf / packTranscript', () => {
  const words = [w('Hello', 200, 500), w('there.', 520, 900), w('Um,', 2400, 2600), w('so', 2700, 2800), w('anyway.', 2820, 3300)]

  it('breaks phrases on pauses of 500 ms or more and keeps the gap before each', () => {
    const phrases = phrasesOf(words)
    expect(phrases.map((p) => p.text)).toEqual(['Hello there.', 'Um, so anyway.'])
    expect(phrases[1].gapBeforeMs).toBe(1500)
  })

  it('packs one line per phrase in source seconds and marks dead air', () => {
    const packed = packTranscript([
      {
        id: 'A',
        file: '/footage/take1.mp4',
        transcript: { version: 1, file: '/footage/take1.mp4', size: 1, mtimeMs: 1, engine: 'parakeet', durationMs: 6000, words },
      },
    ])
    expect(packed).toContain('## A — take1.mp4 (006.00 s, 5 words)')
    expect(packed).toContain('[000.20–000.90] Hello there.')
    expect(packed).toContain('· silence 1.5s ·')
    expect(packed).toContain('[002.40–003.30] Um, so anyway.')
    expect(packed).toContain('· silence 2.7s (to the end) ·')
  })
})

describe('tokensToWords (Parakeet)', () => {
  it('joins BPE pieces into words, glues punctuation and offsets the times', () => {
    // Formato real do sherpa-onnx com o parakeet-tdt-0.6b-v3.
    const words = tokensToWords(
      {
        tokens: [' H', 'ello', ' and', ' W', 'el', 'come', ' ', '1', '.', ' Toda', 'y'],
        timestamps: [0.08, 0.24, 0.56, 0.96, 1.04, 1.2, 3.84, 4.0, 4.16, 4.4, 4.64],
        durations: [0.16, 0.16, 0.08, 0.08, 0.08, 0.08, 0.16, 0.16, 0.24, 0.24, 0.08],
      },
      1000,
    )
    expect(words.map((x) => x.text)).toEqual(['Hello', 'and', 'Welcome', '1.', 'Today'])
    expect(words[0]).toEqual({ text: 'Hello', startMs: 1080, endMs: 1400 })
    expect(words[3]).toEqual({ text: '1.', startMs: 5000, endMs: 5400 })
  })
})
