import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const desktop = path.resolve(__dirname, '../../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const work = path.join(os.tmpdir(), `orbit-audio-measure-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work, getAppPath: () => desktop, isPackaged: false },
  protocol: {},
  BrowserWindow: class {},
}))

const { describeAudioLevels, levelsAt, measureMotionAudio } = await import('./motion-audio-measure')
const { runFfmpeg } = await import('./ffmpeg')

const RATE = 1000
/** 2 s of a constant 0.1 (−20 dBFS) then 2 s of silence. */
const pcm = Float32Array.from({ length: 4 * RATE }, (_, i) => (i < 2 * RATE ? 0.1 : 0))

describe('levelsAt', () => {
  it('reads RMS and peak of the window around an instant', () => {
    const [loud] = levelsAt(pcm, RATE, [1])
    expect(loud.rmsDb).toBeCloseTo(-20, 1)
    expect(loud.peakDb).toBeCloseTo(-20, 1)
  })
  it('says silent where there is no sound, and survives instants past the end', () => {
    const [quiet, past] = levelsAt(pcm, RATE, [3, 99])
    expect(quiet.rmsDb).toBe(-90)
    expect(past.rmsDb).toBe(-90)
  })
  it('only counts what is inside the window at an edge between sound and silence', () => {
    const [edge] = levelsAt(pcm, RATE, [2], 0.25)
    expect(edge.rmsDb).toBeCloseTo(-23, 0) // half of the window is silent
    expect(edge.peakDb).toBeCloseTo(-20, 1)
  })
})

describe('describeAudioLevels', () => {
  it('lists the mix and each track alone, and flags a peak at the ceiling', () => {
    const text = describeAudioLevels(
      [10, 20],
      [{ rmsDb: -22.4, peakDb: -9 }, { rmsDb: -90, peakDb: -0.2 }],
      [
        { name: 'base', levels: [{ rmsDb: -24, peakDb: -12 }, { rmsDb: -90, peakDb: -90 }] },
        { name: 'voz', levels: [{ rmsDb: -18.5, peakDb: -6 }, { rmsDb: -30, peakDb: -20 }] },
      ],
    )
    expect(text).toContain('- 10s: mix -22.4 RMS / -9.0 peak · alone: base -24.0 · voz -18.5')
    expect(text).toContain('- 20s: mix silent RMS / -0.2 peak [PEAK AT THE CEILING')
    expect(text).toContain('base silent')
  })
})

describe.skipIf(!hasFfmpeg)('measureMotionAudio (real ffmpeg)', () => {
  const tone = path.join(work, 'tone.wav')
  beforeAll(async () => {
    await fsp.mkdir(work, { recursive: true })
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ar', '16000', tone])
  })
  afterAll(async () => {
    await fsp.rm(work, { recursive: true, force: true })
  })

  const track = (over: Record<string, unknown>) => ({
    file: tone, name: 'tone', path: 'tone.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false,
    fx: { eq: [], automation: [] }, ...over,
  })

  it('measures the level the manifest asks for: a -6 dB gain and a fade out show up in the numbers', async () => {
    const flat = await measureMotionAudio({ tracks: [track({}) as never], master: null }, [1, 5.9], 6)
    const quieter = await measureMotionAudio({ tracks: [track({ gainDb: -6, fadeOut: 2 }) as never], master: null }, [1, 5.9], 6)
    const rms = (text: string, line: number) => Number(/mix (-?[0-9.]+) RMS/.exec(text.split('\n')[line])![1])
    // the sine has an RMS near -21 dBFS; -6 dB takes 6 off
    expect(rms(flat, 1)).toBeCloseTo(-21, 0)
    expect(rms(quieter, 1)).toBeCloseTo(rms(flat, 1) - 6, 0)
    // inside the 2 s fade out the level has dropped by tens of dB
    expect(rms(quieter, 2)).toBeLessThan(rms(quieter, 1) - 15)
  })

  it('lists each track alone when there are several', async () => {
    const text = await measureMotionAudio({ tracks: [track({ name: 'a' }) as never, track({ name: 'b', gainDb: -12 }) as never], master: null }, [2], 6)
    expect(text).toMatch(/alone: a -2[01]\.\d+ · b -3[23]\.\d+/)
  })

  it('says so when there is nothing to measure', async () => {
    expect(await measureMotionAudio({ tracks: [], master: null }, [1], 6)).toMatch(/no audio track/)
  })
})
