import { runFfmpeg } from './ffmpeg'
import type { MotionAudioPlan } from './motion-audio'
import { motionAudioGraph } from './motion-render-args'

/**
 * What the piece's sound really is at the instants the agent asks about — MEASURED, not
 * reasoned. The mix is built with the very filter graph the render uses (gain, automation,
 * fades, duck, master) and written as raw samples; the windows around each instant are then
 * read for RMS and peak. The agent used to mix "in the dark" ("−22 dB under the voice") and
 * could never check a number; this is the check.
 */

const RATE = 16000
/** Half of the window read around each instant, in seconds. */
const HALF_WINDOW = 0.25
/** Below this a window counts as silence. */
const FLOOR_DB = -90
/** Pieces longer than this are not measured whole: the mix would be minutes of work. */
const MAX_SECONDS = 600

export interface AudioLevel {
  rmsDb: number
  peakDb: number
}

const toDb = (x: number): number => (x > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(x)) : FLOOR_DB)

/** RMS and peak (dBFS) of the window around each instant. Pure. */
export function levelsAt(pcm: Float32Array, rate: number, times: number[], half = HALF_WINDOW): AudioLevel[] {
  return times.map((t) => {
    const from = Math.max(0, Math.floor((t - half) * rate))
    const to = Math.min(pcm.length, Math.ceil((t + half) * rate))
    let sum = 0
    let peak = 0
    for (let i = from; i < to; i++) {
      const v = Math.abs(pcm[i])
      sum += v * v
      if (v > peak) peak = v
    }
    const n = to - from
    return { rmsDb: n > 0 ? toDb(Math.sqrt(sum / n)) : FLOOR_DB, peakDb: toDb(peak) }
  })
}

const fmt = (db: number): string => (db <= FLOOR_DB + 0.5 ? 'silent' : `${db.toFixed(1)}`)

/** The table the agent reads: one line per instant, the mix first, then each track alone. Pure. */
export function describeAudioLevels(
  times: number[],
  mix: AudioLevel[],
  stems: Array<{ name: string; levels: AudioLevel[] }>,
): string {
  const lines = times.map((t, i) => {
    const m = mix[i]
    const clip = m.peakDb >= -0.5 ? ' [PEAK AT THE CEILING — it can clip]' : ''
    const parts = stems.map((s) => `${s.name} ${fmt(s.levels[i].rmsDb)}`)
    return `- ${Number(t.toFixed(2))}s: mix ${fmt(m.rmsDb)} RMS / ${fmt(m.peakDb)} peak${clip}${parts.length ? ` · alone: ${parts.join(' · ')}` : ''}`
  })
  return [
    `Sound at those instants, MEASURED on the mix the render would produce (dBFS, ±${HALF_WINDOW}s window; "alone" = that track after its gain, fades and automation, before ducking and master):`,
    ...lines,
  ].join('\n')
}

async function pcmOf(plan: Pick<MotionAudioPlan, 'tracks' | 'master'>, duration: number, signal?: AbortSignal): Promise<Float32Array> {
  const { graph, output } = motionAudioGraph({ duration, events: plan.tracks, master: plan.master }, 0)
  const { stdout } = await runFfmpeg(
    [
      '-v', 'error',
      ...plan.tracks.flatMap((track) => ['-i', track.file]),
      '-filter_complex', graph.join(';'),
      '-map', `[${output}]`,
      '-t', duration.toFixed(3),
      '-ac', '1',
      '-ar', String(RATE),
      '-f', 'f32le',
      'pipe:1',
    ],
    { signal },
  )
  // Buffer's memory may not be 4-byte aligned: copy into a fresh one.
  const copy = new Uint8Array(stdout.length - (stdout.length % 4))
  copy.set(stdout.subarray(0, copy.length))
  return new Float32Array(copy.buffer)
}

/** Measures the plan's mix at the given instants (seconds on the piece clock). */
export async function measureMotionAudio(
  plan: MotionAudioPlan,
  times: number[],
  durationSeconds: number,
  signal?: AbortSignal,
): Promise<string> {
  if (plan.tracks.length === 0) return 'Sound: the piece has no audio track (audio.json) — nothing to measure.'
  const duration = Math.min(durationSeconds, MAX_SECONDS)
  const mix = levelsAt(await pcmOf(plan, duration, signal), RATE, times)
  const stems: Array<{ name: string; levels: AudioLevel[] }> = []
  if (plan.tracks.length > 1) {
    for (const track of plan.tracks) {
      // Alone: the track with its own treatment, but not ducked (the duck needs the others) and with no master.
      const pcm = await pcmOf({ tracks: [{ ...track, duck: false }], master: null }, duration, signal)
      stems.push({ name: track.name, levels: levelsAt(pcm, RATE, times) })
    }
  }
  return describeAudioLevels(times, mix, stems)
}
