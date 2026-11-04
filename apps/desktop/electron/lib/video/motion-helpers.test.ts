import { describe, expect, it } from 'vitest'
import { MOTION_HELPERS_SCRIPT } from './motion-helpers'

type Easing = Record<string, any>
const h = new Function(
  `${MOTION_HELPERS_SCRIPT}; return { interpolate: orbitInterpolate, spring: orbitSpring, Easing: orbitEasing, sequence: orbitSequence, analyze: orbitAnalyzeAudio, bands: orbitReadBands, mix: orbitMixTracks, gain: orbitTrackGain, trackWords: orbitTrackWords, wordLines: orbitWordLines, wordAt: orbitWordAt, findWord: orbitFindWord, normWord: orbitNormWord, scenes: orbitScenes, random: orbitRandom, fitSize: orbitFitSize, camProgress: orbitCameraProgress, camPlan: orbitCameraPlan, camState: orbitCameraState, camShake: orbitCameraShake, camMatrix: orbitCameraMatrix, camFit: orbitCameraFit, words: orbitWords, textStarts: orbitTextStarts, textState: orbitTextState }`,
)() as {
  interpolate(v: number, i: number[], o: number[], opts?: Record<string, unknown>): number
  spring(o: Record<string, unknown>): number
  Easing: Easing
  sequence(frame: number, from: number, dur?: number): { active: boolean; frame: number; progress: number }
  analyze(s: Float32Array, rate: number, fps: number, frames: number, bands?: number): { level: Float32Array; spec: Float32Array; bands: number; frames: number }
  bands(data: unknown, frame: number, n?: number): number[]
  mix(tracks: Record<string, unknown>[], rate: number, seconds: number): Float32Array
  gain(track: Record<string, unknown>): number
  trackWords(track: Record<string, unknown>, sidecar: unknown): Word[]
  wordLines(words: Word[], opts?: Record<string, unknown>): { start: number; end: number; text: string; words: Word[] }[]
  wordAt(words: Word[], t: number): number
  findWord(words: Word[], text: string, after?: number): number
  normWord(text: string): string
  scenes(list: Record<string, unknown>[], opts?: Record<string, unknown>): Scenes
  random(seed: string | number): number
  fitSize(fits: (size: number) => boolean, min: number, max: number): number | null
  camProgress(style: string, p: number, o?: Record<string, unknown>): number
  camPlan(initial: Cam, list: Record<string, unknown>[]): CamMove[]
  camState(initial: Cam, plan: CamMove[], t: number): Cam
  camShake(shakes: Record<string, unknown>[], t: number): { x: number; y: number; rot: number }
  camMatrix(st: Cam, depth: number, w: number, h: number): number[]
  words(text: string): Array<{ text: string; chars: string[] }>
  textStarts(n: number, o: Record<string, unknown>): number[]
  textState(style: string, p: number, o?: Record<string, unknown>): TextState
  camFit(rect: { x: number; y: number; w: number; h: number }, vw: number, vh: number, o?: Record<string, unknown>): { x: number; y: number; zoom: number }
}
type TextState = { opacity: number; x: number; y: number; scale: number; blur: number; mask: number }
type Cam = { x: number; y: number; zoom: number; rot: number }
type CamMove = { at: number; dur: number; style: string; from: Cam; to: Cam }
type Scene = { name: string; start: number; end: number; dur: number }
type Scenes = {
  list: Scene[]
  total: number
  get(name: string): Scene
  at(t: number): Scene | null
  local(name: string, t: number): { active: boolean; t: number; progress: number }
  [name: string]: unknown
}
type Word = { text: string; start: number; end: number; track?: string }

describe('interpolate', () => {
  it('maps linearly and clamps both ends by default', () => {
    expect(h.interpolate(15, [0, 30], [0, 1])).toBe(0.5)
    expect(h.interpolate(-5, [0, 30], [0, 1])).toBe(0)
    expect(h.interpolate(60, [0, 30], [0, 1])).toBe(1)
    expect(h.interpolate(60, [0, 30], [0, 1], { extrapolateRight: 'extend' })).toBe(2)
  })

  it('handles several segments (fade in, hold, fade out)', () => {
    const range = [0, 10, 50, 60]
    const out = [0, 1, 1, 0]
    expect(h.interpolate(5, range, out)).toBe(0.5)
    expect(h.interpolate(30, range, out)).toBe(1)
    expect(h.interpolate(55, range, out)).toBe(0.5)
  })

  it('applies the easing inside the segment', () => {
    const eased = h.interpolate(15, [0, 30], [0, 100], { easing: h.Easing.easeOut })
    expect(eased).toBeCloseTo(87.5)
    expect(h.interpolate(15, [0, 30], [0, 100], { easing: h.Easing.bezier(0.42, 0, 0.58, 1) })).toBeCloseTo(50, 1)
  })

  it('refuses ranges that make no sense', () => {
    expect(() => h.interpolate(1, [0, 0], [0, 1])).toThrow(/strictly increasing/)
    expect(() => h.interpolate(1, [0, 1], [0])).toThrow(/same length/)
  })
})

describe('spring', () => {
  it('starts at from, overshoots a little with the default damping and settles at to', () => {
    expect(h.spring({ frame: 0, fps: 30 })).toBe(0)
    const values = Array.from({ length: 60 }, (_, f) => h.spring({ frame: f, fps: 30 }))
    expect(Math.max(...values)).toBeGreaterThan(1)
    expect(values[59]).toBeCloseTo(1, 2)
  })

  it('a critically damped or heavier spring never overshoots; delay holds it', () => {
    const heavy = Array.from({ length: 90 }, (_, f) => h.spring({ frame: f, fps: 30, damping: 30 }))
    expect(Math.max(...heavy)).toBeLessThanOrEqual(1)
    expect(h.spring({ frame: 10, fps: 30, delay: 15, from: 5, to: 9 })).toBe(5)
  })
})

describe('sequence', () => {
  it('gives the scene its local frame and progress', () => {
    expect(h.sequence(40, 30, 20)).toEqual({ active: true, frame: 10, progress: 0.5 })
    expect(h.sequence(10, 30, 20).active).toBe(false)
    expect(h.sequence(60, 30, 20)).toMatchObject({ active: false, progress: 1 })
  })
})

describe('audio analysis', () => {
  const rate = 8000

  it('level follows loudness and bands find the frequency', () => {
    // 1 s of silence, then 1 s of a 440 Hz tone.
    const samples = new Float32Array(rate * 2)
    for (let i = rate; i < samples.length; i++) samples[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / rate)
    const data = h.analyze(samples, rate, 10, 20, 16)
    expect(data.level[2]).toBe(0)
    expect(data.level[15]).toBeCloseTo(1, 1)
    const bars = h.bands(data, 15, 16)
    const peak = bars.indexOf(Math.max(...bars))
    // 440 Hz sits in the lower-middle of a 30 Hz–4 kHz log scale.
    expect(peak).toBeGreaterThan(4)
    expect(peak).toBeLessThan(12)
    expect(h.bands(data, 2, 8).every((v) => v === 0)).toBe(true)
  })

  it('mixes on the piece timeline with start, offset, loop and level', () => {
    const ramp = Float32Array.from({ length: 4 }, (_, i) => i + 1) // 1 2 3 4
    const out = h.mix([{ data: ramp, start: 1 / rate, offset: 2 / rate, loop: true, gain: 0.5 }], rate, 8 / rate)
    expect(Array.from(out)).toEqual([0, 1.5, 2, 0.5, 1, 1.5, 2, 0.5])
    expect(h.gain({ gain: -20 })).toBeCloseTo(0.1)
    expect(h.gain({ volume: 0.3 })).toBe(0.3)
  })
})

describe('spoken words', () => {
  const sidecar = {
    words: [
      { text: 'Existe', startMs: 330, endMs: 800 },
      { text: 'diferença,', startMs: 850, endMs: 1500 },
      { text: 'humilde', startMs: 1600, endMs: 2100 },
    ],
  }

  it('moves the words of the file to the piece clock (start + word - offset)', () => {
    const words = h.trackWords({ name: 'Narração 03', file: 'nar.wav', start: 56.6 }, sidecar)
    expect(words.map((w) => w.text)).toEqual(['Existe', 'diferença,', 'humilde'])
    expect(words[0].start).toBeCloseTo(56.93)
    expect(words[2].end).toBeCloseTo(58.7)
    expect(words[0].track).toBe('Narração 03')
  })

  it('drops what the track does not play: before its offset and after its end', () => {
    const cut = h.trackWords({ file: 'nar.wav', start: 10, offset: 0.9, end: 11.2 }, sidecar)
    // "Existe" ends before the offset; "humilde" starts after the end (10 + 1.6 - 0.9 = 10.7 < 11.2 stays)
    expect(cut.map((w) => w.text)).toEqual(['diferença,', 'humilde'])
    expect(cut[0].start).toBeCloseTo(10)
    expect(cut[1].end).toBeCloseTo(11.2)
    expect(h.trackWords({ file: 'x.wav', start: 0 }, null)).toEqual([])
  })

  it('compares words without case, accents or punctuation', () => {
    expect(h.normWord('Diferença,')).toBe('diferenca')
    expect(h.normWord('"HUMILDE!"')).toBe('humilde')
  })

  it('finds when a word or a phrase is first spoken', () => {
    const words = h.trackWords({ file: 'nar.wav', start: 56.6 }, sidecar)
    expect(h.findWord(words, 'Humilde')).toBeCloseTo(58.2)
    expect(h.findWord(words, 'existe diferença')).toBeCloseTo(56.93)
    expect(h.findWord(words, 'humilde', 59)).toBe(-1)
    expect(h.findWord(words, 'orgulho')).toBe(-1)
  })

  it('says which word is being spoken at an instant', () => {
    const words = h.trackWords({ file: 'nar.wav', start: 0 }, sidecar)
    expect(h.wordAt(words, 0.1)).toBe(-1)
    expect(h.wordAt(words, 0.9)).toBe(1)
    expect(h.wordAt(words, 99)).toBe(2)
  })

  it('groups words in lines at a pause, at punctuation and at the word limit', () => {
    const w = (text: string, start: number, end: number) => ({ text, start, end })
    const lines = h.wordLines([w('um', 0, 0.2), w('dois', 0.25, 0.5), w('tres.', 0.55, 0.9), w('quatro', 2, 2.3), w('cinco', 2.35, 2.6)])
    expect(lines.map((l) => l.text)).toEqual(['um dois tres.', 'quatro cinco'])
    expect(lines[1].start).toBe(2)
    expect(h.wordLines([w('a', 0, 1), w('b', 1, 2), w('c', 2, 3)], { maxWords: 2 }).map((l) => l.text)).toEqual(['a b', 'c'])
  })
})

describe('scenes', () => {
  it('lays the scenes out one after the other from their durations', () => {
    const S = h.scenes([{ name: 'intro', dur: 4 }, { name: 'verse', dur: 20 }, { name: 'payoff', dur: 3 }])
    expect(S.list.map((s) => [s.start, s.end])).toEqual([[0, 4], [4, 24], [24, 27]])
    expect(S.total).toBe(27)
    expect((S.verse as Scene).start).toBe(4)
  })

  it('cutting a scene moves every scene after it, with nothing else to edit', () => {
    const before = h.scenes([{ name: 'a', dur: 4 }, { name: 'b', dur: 20 }, { name: 'c', dur: 3 }])
    const after = h.scenes([{ name: 'a', dur: 4 }, { name: 'b', dur: 9.5 }, { name: 'c', dur: 3 }])
    expect(before.get('c').start - after.get('c').start).toBeCloseTo(10.5)
    expect(after.total).toBeCloseTo(16.5)
  })

  it('overlaps (a crossfade) and gaps', () => {
    const S = h.scenes([{ name: 'a', dur: 4 }, { name: 'b', dur: 4, overlap: 0.5 }, { name: 'c', dur: 2, gap: 1 }], {})
    expect(S.get('b').start).toBe(3.5)
    expect(S.get('c').start).toBe(8.5)
    expect(h.scenes([{ name: 'a', dur: 4 }, { name: 'b', dur: 4 }], { overlap: 1 }).total).toBe(7)
    // an overlap longer than the scene itself is held to it
    expect(h.scenes([{ name: 'a', dur: 1 }, { name: 'b', dur: 4, overlap: 9 }]).get('b').start).toBe(0)
  })

  it('answers which scene is on at t (the incoming one during an overlap) and the local time', () => {
    const S = h.scenes([{ name: 'a', dur: 4 }, { name: 'b', dur: 4, overlap: 1 }])
    expect(S.at(1)?.name).toBe('a')
    expect(S.at(3.5)?.name).toBe('b')
    expect(S.at(99)).toBeNull()
    expect(S.local('b', 5)).toEqual({ active: true, t: 2, progress: 0.5 })
    expect(S.local('b', 1).active).toBe(false)
  })

  it('refuses what makes no sense, with the reason', () => {
    expect(() => h.scenes([])).toThrow(/pass a list/)
    expect(() => h.scenes([{ dur: 3 }])).toThrow(/needs a name/)
    expect(() => h.scenes([{ name: 'a', dur: 0 }])).toThrow(/needs dur > 0/)
    expect(() => h.scenes([{ name: 'a', dur: 1 }, { name: 'a', dur: 1 }])).toThrow(/two scenes/)
    expect(() => h.scenes([{ name: 'a', dur: 1 }]).get('zzz')).toThrow(/no scene "zzz"/)
  })

  it('does not let a scene named like a method shadow it', () => {
    const S = h.scenes([{ name: 'total', dur: 2 }])
    expect(S.total).toBe(2)
    expect(S.get('total').dur).toBe(2)
  })
})

describe('random', () => {
  it('is a pure function of the seed: same seed, same number', () => {
    expect(h.random('p1:x')).toBe(h.random('p1:x'))
    expect(h.random(7)).toBe(h.random('7'))
    expect(h.random('p1:x')).not.toBe(h.random('p2:x'))
  })
  it('stays in [0, 1) and is spread out', () => {
    const values = Array.from({ length: 2000 }, (_, i) => h.random(`s${i}`))
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...values)).toBeLessThan(1)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
    const buckets = new Array(10).fill(0)
    for (const v of values) buckets[Math.floor(v * 10)]++
    expect(Math.min(...buckets)).toBeGreaterThan(130)
  })
})

describe('fit size search', () => {
  it('finds the largest size that fits', () => {
    expect(h.fitSize((s) => s <= 104, 8, 600)).toBe(104)
    expect(h.fitSize((s) => s <= 8, 8, 600)).toBe(8)
    expect(h.fitSize(() => true, 8, 600)).toBe(600)
  })
  it('says null when not even the smallest fits', () => {
    expect(h.fitSize(() => false, 8, 600)).toBeNull()
  })
})

describe('camera', () => {
  const home: Cam = { x: 540, y: 960, zoom: 1, rot: 0 }
  /** Where a point of the world lands on screen with this matrix. */
  const project = (m: number[], x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })

  it('every style starts at 0 and ends at 1', () => {
    for (const style of ['ease', 'linear', 'push', 'pull', 'slingshot', 'whip']) {
      expect(h.camProgress(style, 0)).toBeCloseTo(0, 6)
      expect(h.camProgress(style, 1)).toBeCloseTo(1, 6)
    }
  })

  it('push accelerates into the lens and pull settles', () => {
    expect(h.camProgress('push', 0.5)).toBeLessThan(0.3)
    expect(h.camProgress('pull', 0.5)).toBeGreaterThan(0.7)
    expect(h.camProgress('ease', 0.5)).toBeCloseTo(0.5, 6)
  })

  it('slingshot winds up the other way, then overshoots, then settles on the target', () => {
    const values = Array.from({ length: 101 }, (_, i) => h.camProgress('slingshot', i / 100))
    expect(Math.min(...values)).toBeLessThan(-0.05)
    expect(Math.max(...values)).toBeGreaterThan(1.02)
    expect(values[100]).toBeCloseTo(1, 6)
    // and it is continuous: no jump at the end of the wind-up
    for (let i = 1; i < values.length; i++) expect(Math.abs(values[i] - values[i - 1])).toBeLessThan(0.2)
  })

  it('a move only says what changes; the rest stays where the previous one left it', () => {
    const plan = h.camPlan(home, [
      { at: 1, dur: 1, to: { zoom: 2 } },
      { at: 3, dur: 1, to: { x: 100 } },
    ])
    expect(plan[0].to).toEqual({ x: 540, y: 960, zoom: 2, rot: 0 })
    expect(plan[1].from.zoom).toBe(2)
    expect(plan[1].to).toEqual({ x: 100, y: 960, zoom: 2, rot: 0 })
  })

  it('refuses overlapping moves, a bad style, no duration and a zero zoom — with the reason', () => {
    expect(() => h.camPlan(home, [{ at: 0, dur: 2, to: { zoom: 2 } }, { at: 1, dur: 1, to: { zoom: 3 } }])).toThrow(/cannot overlap/)
    expect(() => h.camPlan(home, [{ at: 0, style: 'bounce' }])).toThrow(/does not exist/)
    expect(() => h.camPlan(home, [{ at: 0, dur: 0 }])).toThrow(/dur > 0/)
    expect(() => h.camPlan(home, [{ at: 0, to: { zoom: 0 } }])).toThrow(/zoom > 0/)
  })

  it('holds before, between and after the moves', () => {
    const plan = h.camPlan(home, [{ at: 1, dur: 1, to: { x: 200, zoom: 4 } }])
    expect(h.camState(home, plan, 0.5)).toEqual(home)
    expect(h.camState(home, plan, 5)).toEqual({ x: 200, y: 960, zoom: 4, rot: 0 })
  })

  it('zooms geometrically: half the time is half the ratio, not half the zoom', () => {
    const plan = h.camPlan(home, [{ at: 0, dur: 2, style: 'linear', to: { zoom: 4 } }])
    expect(h.camState(home, plan, 1).zoom).toBeCloseTo(2, 6)
  })

  it('is a pure function of time', () => {
    const plan = h.camPlan(home, [{ at: 0, dur: 2, style: 'slingshot', to: { x: 900, zoom: 3 } }])
    const a = h.camState(home, plan, 0.77)
    expect(h.camState(home, plan, 0.1)).not.toEqual(a)
    expect(h.camState(home, plan, 0.77)).toEqual(a)
  })

  it('the matrix puts the camera centre in the middle of the frame, at any zoom and rotation', () => {
    for (const st of [home, { x: 800, y: 300, zoom: 2.5, rot: 0 }, { x: 100, y: 1500, zoom: 0.5, rot: 33 }]) {
      const p = project(h.camMatrix(st, 1, 1080, 1920), st.x, st.y)
      expect(p.x).toBeCloseTo(540, 4)
      expect(p.y).toBeCloseTo(960, 4)
    }
  })

  it('zoom scales around the centre: a point 100 px to the right lands 200 px away at zoom 2', () => {
    const p = project(h.camMatrix({ ...home, zoom: 2 }, 1, 1080, 1920), 640, 960)
    expect(p.x - 540).toBeCloseTo(200, 4)
  })

  it('depth is parallax: a far layer moves less than the near one for the same pan', () => {
    const st = { x: 740, y: 960, zoom: 1, rot: 0 } // panned 200 px right
    const move = (depth: number) => 540 - project(h.camMatrix(st, depth, 1080, 1920), 540, 960).x
    expect(move(1)).toBeCloseTo(200, 4)
    expect(move(2)).toBeCloseTo(100, 4)
    expect(move(0.5)).toBeCloseTo(400, 4)
  })

  it('fit contain keeps the rectangle in view; cover fills the frame with it', () => {
    const rect = { x: 100, y: 200, w: 400, h: 200 }
    const contain = h.camFit(rect, 1080, 1920)
    expect(contain).toMatchObject({ x: 300, y: 300 })
    expect(contain.zoom).toBeCloseTo(2.7, 6) // limited by the width: 1080 / 400
    const cover = h.camFit(rect, 1080, 1920, { fit: 'cover' })
    expect(cover.zoom).toBeCloseTo(9.6, 6) // limited by the height: 1920 / 200
    expect(h.camFit(rect, 1080, 1920, { padding: 40 }).zoom).toBeCloseTo(2.5, 6)
  })

  it('shake is zero outside its window, dies out by the end and is deterministic', () => {
    const s = [{ at: 1, dur: 0.5, amp: 20, rot: 1, freq: 20, seed: 'a' }]
    expect(h.camShake(s, 0.5)).toEqual({ x: 0, y: 0, rot: 0 })
    expect(h.camShake(s, 2)).toEqual({ x: 0, y: 0, rot: 0 })
    const early = Math.abs(h.camShake(s, 1.05).x)
    expect(early).toBeGreaterThan(0)
    expect(Math.abs(h.camShake(s, 1.499).x)).toBeLessThan(0.5)
    expect(h.camShake(s, 1.2)).toEqual(h.camShake(s, 1.2))
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => Math.abs(h.camShake(s, 1 + i * 0.01).x)))).toBeLessThanOrEqual(20)
  })
})

describe('text effects (pure)', () => {
  const styles = ['fade', 'rise', 'drop', 'pop', 'mask', 'blur', 'slide', 'typewriter']

  it('splits into words and code points, whatever the whitespace', () => {
    expect(h.words('  Olá\t\nmundo  ').map((w) => w.text)).toEqual(['Olá', 'mundo'])
    expect(h.words('a 👍b')[1].chars).toEqual(['👍', 'b'])
    expect(h.words('   ')).toEqual([])
  })

  it('every style ends untouched at p = 1 and is hidden at p = 0', () => {
    for (const style of styles) {
      expect(h.textState(style, 1)).toEqual({ opacity: 1, x: 0, y: 0, scale: 1, blur: 0, mask: 0 })
      const hidden = h.textState(style, 0)
      const out = hidden.opacity === 0 || hidden.scale === 0 || hidden.mask > 100
      expect(out, style).toBe(true)
    }
  })

  it('rise comes from below and drop from above; slide follows the direction; blur clears', () => {
    expect(h.textState('rise', 0.2).y).toBeGreaterThan(0)
    expect(h.textState('drop', 0.2).y).toBeLessThan(0)
    expect(h.textState('slide', 0.2).x).toBeGreaterThan(0)
    expect(h.textState('slide', 0.2, { direction: 'right' }).x).toBeLessThan(0)
    expect(h.textState('blur', 0.1).blur).toBeGreaterThan(h.textState('blur', 0.9).blur)
  })

  it('pop overshoots before it settles', () => {
    const peak = Math.max(...Array.from({ length: 101 }, (_, i) => h.textState('pop', i / 100).scale))
    expect(peak).toBeGreaterThan(1.02)
  })

  it('refuses a style that does not exist, with the list', () => {
    expect(() => h.textState('spin', 0.5)).toThrow(/does not exist — use fade, rise/)
  })

  it('stagger orders: forward, reverse, from the centre, a fixed shuffle', () => {
    const base = { at: 1, stagger: 0.1 }
    expect(h.textStarts(4, base)).toEqual([1, 1.1, 1.2, 1.3])
    expect(h.textStarts(4, { ...base, order: 'reverse' })).toEqual([1.3, 1.2, 1.1, 1])
    const center = h.textStarts(5, { ...base, order: 'center' })
    expect(center[2]).toBe(1) // the middle first
    expect(Math.max(center[0], center[4])).toBeCloseTo(1.4, 6) // the ends last
    const a = h.textStarts(6, { ...base, order: 'random', seed: 'x' })
    expect(a).toEqual(h.textStarts(6, { ...base, order: 'random', seed: 'x' }))
    expect([...a].sort((x, y) => x - y)).toEqual([1, 1.1, 1.2, 1.3, 1.4, 1.5].map((n) => expect.closeTo(n, 6)))
    expect(a).not.toEqual(h.textStarts(6, { ...base, order: 'random', seed: 'y' }))
  })
})
