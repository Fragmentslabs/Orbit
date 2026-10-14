import { describe, expect, it } from 'vitest'
import {
  buildAss,
  chunkWords,
  cutPointsMs,
  edgeFadeFilter,
  edlSchema,
  gradeFilter,
  outputSize,
  outputWords,
  snapRanges,
  totalDurationMs,
  type TimedWord,
} from './edl'

const w = (text: string, startMs: number, endMs: number): TimedWord => ({ text, startMs, endMs })

// "hello world . this is a test" com um silêncio de 1,2 s no meio.
const WORDS: TimedWord[] = [
  w('Hello', 500, 900),
  w('world.', 950, 1400),
  w('This', 2600, 2800),
  w('is', 2850, 2950),
  w('a', 3000, 3050),
  w('test.', 3100, 3600),
]

describe('snapRanges', () => {
  it('moves an edge that fell inside a word out of it, and records why', () => {
    const { ranges, notes } = snapRanges([{ source: 'A', start: 0.6, end: 1.2 }], { A: WORDS }, { padMs: 0 })
    expect(ranges[0].startMs).toBe(500)
    expect(ranges[0].endMs).toBe(1400)
    expect(notes.map((n) => n.edge)).toEqual(['start', 'end'])
    expect(notes[0].why).toContain('Hello')
  })

  it('adds air around the cut without eating into the neighbouring words', () => {
    const { ranges } = snapRanges([{ source: 'A', start: 2.6, end: 2.95 }], { A: WORDS }, { padMs: 200 })
    // Antes: silêncio desde 1400 → pode recuar os 200 ms inteiros.
    expect(ranges[0].startMs).toBe(2400)
    // Depois: "a" começa em 3000 → a folga para ali.
    expect(ranges[0].endMs).toBe(3000)
  })

  it('leaves times alone when there is no transcript or snapping is off', () => {
    const a = snapRanges([{ source: 'A', start: 0.6, end: 1.2 }], {}, {})
    expect([a.ranges[0].startMs, a.ranges[0].endMs]).toEqual([600, 1200])
    const b = snapRanges([{ source: 'A', start: 0.6, end: 1.2 }], { A: WORDS }, { snap: false })
    expect([b.ranges[0].startMs, b.ranges[0].endMs]).toEqual([600, 1200])
  })

  it('clamps to the source duration and lays ranges on the output timeline', () => {
    const { ranges } = snapRanges(
      [
        { source: 'A', start: 0, end: 1 },
        { source: 'B', start: 5, end: 99 },
      ],
      {},
      { durationsMs: { B: 8000 } },
    )
    expect(ranges[1].endMs).toBe(8000)
    expect(ranges.map((r) => r.outStartMs)).toEqual([0, 1000])
    expect(totalDurationMs(ranges)).toBe(4000)
    expect(cutPointsMs(ranges)).toEqual([1000])
  })
})

describe('outputWords + chunkWords', () => {
  it('keeps only words whose middle survives the cut, in output time', () => {
    const { ranges } = snapRanges(
      [
        { source: 'A', start: 2.5, end: 3.7 },
        { source: 'A', start: 0.4, end: 1.5 },
      ],
      { A: WORDS },
      { padMs: 0 },
    )
    const out = outputWords(ranges, { A: WORDS })
    expect(out.map((x) => x.text)).toEqual(['This', 'is', 'a', 'test.', 'Hello', 'world.'])
    // "This" abre a saída (o trecho começa em 2.5 s, a palavra em 2.6 s).
    expect(out[0].startMs).toBe(100)
    // "Hello" vem depois do primeiro trecho inteiro (1200 ms).
    expect(out[4].startMs).toBe(1200 + 100)
  })

  it('chunks by size, breaks on sentence ends and long pauses, and closes tiny gaps', () => {
    const cues = chunkWords(WORDS, 2, true)
    expect(cues.map((c) => c.text)).toEqual(['HELLO WORLD.', 'THIS IS', 'A TEST.'])
    // 2950 → 3000: 50 ms de buraco entre "THIS IS" e "A TEST." vira contínuo.
    expect(cues[1].endMs).toBe(cues[2].startMs)
    // O silêncio de 1,2 s fica: a legenda não segura o texto por cima dele.
    expect(cues[0].endMs).toBe(1400)
  })
})

describe('buildAss', () => {
  it('writes a styled ASS file with escaped text in the output resolution', () => {
    const ass = buildAss([{ startMs: 1234, endMs: 65_000, text: 'A {B}' }], { style: 'bold-overlay' }, { width: 1080, height: 1920 })
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
    expect(ass).toContain('Dialogue: 0,0:00:01.23,0:01:05.00,Default,,0,0,0,,A \\{B\\}')
    // Bold (-1) e alinhamento embaixo-centro (2).
    expect(ass).toMatch(/Style: Default,Arial,\d+,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,.*,2,\d+,\d+,\d+,1/)
  })
})

describe('filters and sizes', () => {
  it('resolves grade presets and rejects filter graphs', () => {
    expect(gradeFilter('none')).toBe('')
    expect(gradeFilter('neutral_punch')).toContain('curves')
    expect(gradeFilter('eq=contrast=1.1')).toBe('eq=contrast=1.1')
    expect(() => gradeFilter('[0:v]split[a][b]')).toThrow()
  })

  it('fades both edges of a segment in 30 ms (shorter on very short ones)', () => {
    expect(edgeFadeFilter(2000)).toContain('afade=t=in:st=0:d=0.030,afade=t=out:st=1.970:d=0.030')
    expect(edgeFadeFilter(80)).toContain('d=0.020')
    expect(edgeFadeFilter(2000, -3)).toContain('volume=-3dB')
  })

  it('keeps even sizes and caps previews at 720p', () => {
    const edl = edlSchema.parse({ sources: { A: 'a.mp4' }, ranges: [{ source: 'A', start: 0, end: 1 }] })
    expect(outputSize(edl, { width: 1920, height: 1080 }, false)).toEqual({ width: 1920, height: 1080 })
    expect(outputSize(edl, { width: 1920, height: 1080 }, true)).toEqual({ width: 1280, height: 720 })
    expect(outputSize(edl, { width: 1081, height: 1921 }, false)).toEqual({ width: 1080, height: 1920 })
  })
})
