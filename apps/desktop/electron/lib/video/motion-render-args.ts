import path from 'node:path'
import {
  DEFAULT_DUCK,
  automationFilter,
  duckFilter,
  hasMasterFx,
  hasTrackFx,
  masterFilters,
  toneFilters,
  type DuckSettings,
  type MasterFx,
  type TrackFx,
} from './motion-audio-fx'

/**
 * The PURE part of the motion render: the ffmpeg arguments, the alpha
 * unpremultiplication and the splitting of the work into tracks. It sits apart from motion.ts (which opens
 * the window, captures and talks to Electron) so it can be tested without any
 * window — it is where the decisions live that, wrong, would only show up in a crooked video.
 *
 * The pixel path changed from PNG to rawvideo (the raw BGRA bitmap that
 * nativeImage already has): a PNG per frame cost an encode in Chromium and a
 * decode in ffmpeg, per frame. In exchange, rawvideo imposes two rules:
 *
 *  1. the frame size has to be CONSTANT — hence the probing of one frame
 *     in motion.ts before starting ffmpeg (the capture may come at the screen
 *     scale, HiDPI) and the byte-per-frame check;
 *  2. Chromium's alpha is PREMULTIPLIED and has to become straight color BEFORE the
 *     format conversion — after it becomes yuva444p10le/yuva420p there is no more
 *     recovering it. What does that is `unpremultiplyBgra`, down below (and not an
 *     ffmpeg filter: see the note in the function).
 */

/** Output formats. `-alpha` = the container really carries alpha. */
export type MotionFormat = 'mp4' | 'webm' | 'mov-alpha' | 'webm-alpha'

/**
 * Name that the `motion:render` IPC accepts. Frozen contract with the panel
 * tab (see src/lib/ipc.ts): `mp4`, `mov-alpha` and `webm-alpha`. The old names
 * (`mov`, `webm`) are still accepted by normalizeMotionFormat.
 */
export type MotionFormatInput = MotionFormat | 'mov'

/** Cap on parallel tracks: more than that does not speed things up and multiplies windows. */
export const MAX_MOTION_BANDS = 4

/** File extension of each format's output. */
export function motionFormatExt(format: MotionFormat): string {
  if (format === 'mov-alpha') return '.mov'
  if (format === 'webm' || format === 'webm-alpha') return '.webm'
  return '.mp4'
}

/** Does the container carry alpha? (only ProRes 4444 and VP9 with alpha). */
export function isAlphaFormat(format: MotionFormat): boolean {
  return format === 'mov-alpha' || format === 'webm-alpha'
}

/** Alpha pixel format of the encoder (null when there is no alpha). */
export function alphaPixelFormat(format: MotionFormat): string | null {
  if (format === 'mov-alpha') return 'yuva444p10le'
  if (format === 'webm-alpha') return 'yuva420p'
  return null
}

/**
 * Format from the output file NAME and the transparency — the path of the
 * `motion_render` tool, which only receives `output` + `transparent`. Pure.
 * `.mov` without transparency still comes out as H.264, as before.
 */
export function motionFormatFor(output: string, transparent: boolean): MotionFormat {
  const ext = path.extname(output).toLowerCase()
  if (transparent) {
    if (ext === '.mov') return 'mov-alpha'
    if (ext === '.webm') return 'webm-alpha'
    throw new Error('transparent output needs a .mov (ProRes 4444) or .webm (VP9) file name')
  }
  return ext === '.webm' ? 'webm' : 'mp4'
}

/**
 * Normalizes the `format` that arrives from outside (IPC, tab). Without a format, mp4. The old
 * names still hold: `mov` was always ProRes 4444 (with alpha) and `webm` without
 * transparency was VP9 without alpha.
 */
export function normalizeMotionFormat(raw: string | undefined, transparent = false): MotionFormat {
  switch (raw) {
    case undefined:
    case '':
    case 'mp4':
      return 'mp4'
    case 'mov':
    case 'mov-alpha':
      return 'mov-alpha'
    case 'webm':
      return transparent ? 'webm-alpha' : 'webm'
    case 'webm-alpha':
      return 'webm-alpha'
    default:
      throw new Error(`unsupported motion format: ${raw}`)
  }
}

/**
 * How much the file may weigh. `balanced` is what always comes out with no choice —
 * it is the previous default, and it is what the old button produced.
 */
export type MotionQuality = 'high' | 'balanced' | 'small'

/** Numbers per format: CRF (smaller = better) and x264 preset. */
const QUALITY: Record<MotionFormat, Record<MotionQuality, { crf: number; preset: string }>> = {
  mp4: {
    high: { crf: 16, preset: 'slow' },
    balanced: { crf: 18, preset: 'medium' },
    small: { crf: 26, preset: 'fast' },
  },
  webm: {
    high: { crf: 24, preset: 'medium' },
    balanced: { crf: 30, preset: 'medium' },
    small: { crf: 36, preset: 'medium' },
  },
  'webm-alpha': {
    high: { crf: 24, preset: 'medium' },
    balanced: { crf: 28, preset: 'medium' },
    small: { crf: 34, preset: 'medium' },
  },
  // ProRes 4444 has no CRF: the quality is fixed by the profile. The choice is ignored.
  'mov-alpha': {
    high: { crf: 0, preset: 'medium' },
    balanced: { crf: 0, preset: 'medium' },
    small: { crf: 0, preset: 'medium' },
  },
}

/** Encoder arguments per format (the same parameters as before rawvideo). */
export function motionEncoderArgs(format: MotionFormat, quality: MotionQuality = 'balanced'): string[] {
  if (format === 'mov-alpha') return ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
  const { crf, preset } = QUALITY[format][quality]
  if (format === 'webm-alpha') {
    return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', String(crf), '-row-mt', '1']
  }
  if (format === 'webm') {
    return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', String(crf), '-row-mt', '1']
  }
  return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
}

/**
 * Rawvideo input: one BGRA frame per stdin read, no header. The `-s`
 * is mandatory and it is what forces the frame size to be constant.
 */
export function rawVideoInputArgs(width: number, height: number, fps: number): string[] {
  return ['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0']
}

export interface RawVideoFilterOptions {
  /** FINAL size of the video — the same as before rawvideo. */
  width: number
  height: number
  /** Size of the frame the window returns (it may come at the screen scale). */
  captureWidth: number
  captureHeight: number
  format: MotionFormat
}

/**
 * Filters of the raw frame, in the order that matters:
 *
 *  1. `scale` only when the capture comes larger (HiDPI) — the video has to come out at the
 *     same size as before;
 *  2. `format=` in transparent mode, so the alpha arrives whole at the encoder.
 *
 * There is no unpremultiplication filter: it already happened in `unpremultiplyBgra`,
 * over the buffer, BEFORE this format conversion (see the note in the function).
 */
export function rawVideoFilters(o: RawVideoFilterOptions): string[] {
  const filters: string[] = []
  if (o.captureWidth !== o.width || o.captureHeight !== o.height) {
    filters.push(`scale=${o.width}:${o.height}:flags=lanczos`)
  }
  if (isAlphaFormat(o.format)) {
    const pix = alphaPixelFormat(o.format)
    if (pix) filters.push(`format=${pix}`)
  }
  return filters
}

export interface MotionFfmpegSpec extends RawVideoFilterOptions {
  fps: number
  output: string
  /** File weight/quality; without it, the usual `balanced`. */
  quality?: MotionQuality
}

/**
 * COMPLETE ffmpeg arguments of one segment (one track): the stdin is
 * rawvideo and the output already comes out of the final encoder. Pure — it is what the tests lock down.
 */
export function motionFfmpegArgs(spec: MotionFfmpegSpec): string[] {
  const filters = rawVideoFilters(spec)
  return [
    '-v', 'error',
    ...rawVideoInputArgs(spec.captureWidth, spec.captureHeight, spec.fps),
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    ...motionEncoderArgs(spec.format, spec.quality),
    '-r', String(spec.fps),
    spec.output,
  ]
}

/** Bytes of one BGRA frame — the CONSTANT size that rawvideo demands. */
export function expectedFrameBytes(width: number, height: number): number {
  return width * height * 4
}

/**
 * Rawvideo has no size header: a frame with one byte more or less
 * misaligns the whole rest of the stream and the video comes out as colored garbage, with no
 * error at all. That is why the render checks EVERY frame and stops here, with the size that
 * came and the one that was expected.
 */
export function assertFrameBytes(bufferLength: number, width: number, height: number, frame: number): void {
  const expected = expectedFrameBytes(width, height)
  if (bufferLength === expected) return
  throw new Error(
    `motion: frame ${frame} came with ${bufferLength} bytes, expected ${width}x${height}x4 = ${expected} ` +
      '(the capture changed size mid-render — rawvideo needs a constant frame size)',
  )
}

/** `255 * 256 / alpha`, rounded: dividing per pixel becomes multiplying and shifting. */
const UNPREMULTIPLY = (() => {
  const table = new Uint16Array(256)
  for (let alpha = 1; alpha < 256; alpha++) table[alpha] = Math.round((255 * 256) / alpha)
  return table
})()

/** value * 255 / alpha, rounded and clamped to 255 (a color larger than the alpha would leave the byte). */
function straight(value: number, factor: number): number {
  // +128 before the shift is the rounding to the nearest integer.
  const scaled = (value * factor + 128) >> 8
  return scaled > 255 ? 255 : scaled
}

/**
 * Unpremultiplies the alpha IN PLACE: premultiplied BGRA (what Chromium's `toBitmap`
 * delivers) becomes straight color, which is what the encoder expects.
 *
 * Why here and not in an ffmpeg filter: the `unpremultiply` of the build the app
 * ships with (ffmpeg 9.0.2) does not handle this. It has TWO inputs ("UnPre
 * Multiply first stream with first plane of second stream") and with `-vf
 * unpremultiply` ffmpeg refuses the graph — "Simple filtergraph '(null)' was
 * expected to have exactly 1 input and 1 output. However, it had 2 input(s)".
 * The one-input variant (`unpremultiply=inplace=1`) runs, but changes nothing
 * (measured with (100,50,25,128): it comes out (99,50,26,129), the same frame), and the
 * two-input graph with `alphaextract` returns the image in GRAY. Doing the math here
 * is deterministic, does not depend on the ffmpeg build and happens before the format
 * conversion — which is what matters, because after it becomes yuva444p10le/yuva420p
 * the alpha is no longer recoverable.
 *
 * Cost: only on the SEMI-transparent pixels (opaque and empty ones go right away) and only on the
 * alpha path — the opaque path has a solid black background and arrives with alpha 255.
 */
export function unpremultiplyBgra(buffer: Buffer): void {
  for (let i = 0; i + 3 < buffer.length; i += 4) {
    const alpha = buffer[i + 3]
    if (alpha === 255 || alpha === 0) continue
    const factor = UNPREMULTIPLY[alpha]
    buffer[i] = straight(buffer[i], factor)
    buffer[i + 1] = straight(buffer[i + 1], factor)
    buffer[i + 2] = straight(buffer[i + 2], factor)
  }
}

/**
 * How many parallel tracks: explicit `bands` when it comes (1 = the sequential,
 * deterministic path), otherwise min(4, max(1, cores/2)).
 */
export function bandCount(requested: number | undefined, cores: number): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.min(MAX_MOTION_BANDS, Math.max(1, Math.floor(requested)))
  }
  const auto = Number.isFinite(cores) ? Math.floor(cores / 2) : 1
  return Math.min(MAX_MOTION_BANDS, Math.max(1, auto))
}

/**
 * Splits [0, total) into contiguous, balanced tracks, in order — `[start, end)`,
 * in WHOLE FRAMES: each track fetches only its own frames (nothing is fetched
 * twice) and the concatenation comes out in the right order. Never returns an empty track.
 */
export function splitBands(total: number, bands: number): Array<{ start: number; end: number }> {
  const frames = Math.max(1, Math.floor(total))
  const count = Math.min(Math.max(1, Math.floor(bands)), frames)
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  for (let i = 0; i < count; i++) {
    const size = Math.floor(frames / count) + (i < frames % count ? 1 : 0)
    out.push({ start, end: start + size })
    start += size
  }
  return out
}

export interface ConcatSpec {
  /** concat demuxer list (names relative to ffmpeg's cwd). */
  listFile: string
  output: string
  format: MotionFormat
}

/** Content of the concat demuxer's `list.txt`: one `file '...'` per segment. */
export function concatList(names: string[]): string {
  return names.map((name) => `file '${name}'`).join('\n')
}

/**
 * Joins the segments of the tracks WITHOUT a second loss (`-c copy`), like the EDL
 * render. The segments already came out of the final encoder, so here it is only a remux — the
 * `+faststart` goes back for the mp4.
 *
 * It does not promise output byte-identical to the sequential path: each track starts its
 * own GOP, so the keyframes fall at different points.
 */
export function concatFfmpegArgs(spec: ConcatSpec): string[] {
  return [
    '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', spec.listFile,
    '-c', 'copy',
    ...(spec.format === 'mp4' ? ['-movflags', '+faststart'] : []),
    spec.output,
  ]
}

// -------------------------------------------------------------------- audio

/**
 * The piece's audio. The capture takes FRAMES, not sound (the window is offscreen and
 * ffmpeg receives rawvideo on stdin), so the track enters on a final pass,
 * after the video is assembled — without re-encoding the picture (`-c:v copy`).
 *
 * Without an explicit path, the conventional name inside the composition's folder counts:
 * audio, like images and fonts, is content of the piece and lives with it.
 */
export const MOTION_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac']

/** Is it audio by the file name? Pure. */
export function isMotionAudioFile(file: string): boolean {
  return MOTION_AUDIO_EXTENSIONS.includes(path.extname(file).toLowerCase())
}

/**
 * Audio codec by the CONTAINER — it is not an aesthetic choice: it is what each one
 * accepts. aac in mp4/mov (ProRes 4444 included), Opus in webm.
 */
export function motionAudioCodec(format: MotionFormat): string[] {
  if (format === 'webm' || format === 'webm-alpha') return ['-c:a', 'libopus', '-b:a', '128k']
  return ['-c:a', 'aac', '-b:a', '192k']
}

export interface MotionAudioSpec {
  /** Video ALREADY assembled (the single segment, or the concatenation of the tracks). */
  video: string
  audio: string
  output: string
  /** Duration of the composition, in seconds: it is what rules the length. */
  duration: number
  format: MotionFormat
}

/**
 * Final pass: joins the audio to the video and ONLY it writes the requested file. The
 * picture is not touched (`-c:v copy`), only the sound is encoded.
 *
 * `-t` fixes the length at the piece's duration, and it is the decision that matters:
 *  - audio LONGER than the piece is cut at its end (it never stretches the video);
 *  - shorter audio leaves the tail in silence;
 *  - `-shortest`, which is the common reflex, would do the opposite of the first case:
 *    short audio would shorten the VIDEO, and the piece would end before the drawing.
 * `-t` never eats the last frame: the last packet is at `(total-1)/fps`,
 * always more than one frame before the declared duration.
 */
export function motionAudioFfmpegArgs(spec: MotionAudioSpec): string[] {
  return [
    '-v', 'error',
    '-i', spec.video,
    '-i', spec.audio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    ...motionAudioCodec(spec.format),
    '-t', spec.duration.toFixed(3),
    ...(spec.format === 'mp4' ? ['-movflags', '+faststart'] : []),
    spec.output,
  ]
}

/** A track already resolved, ready to become a filter (absolute paths). */
export interface MotionAudioEvent {
  file: string
  /** Second of the piece at which it comes in. */
  start: number
  /** Second at which it goes out; absent = to the end of the file. */
  end?: number
  gainDb: number
  fadeIn: number
  fadeOut: number
  /** Bed that goes down under the other tracks. */
  duck: boolean
  /** How it goes down; absent = the usual numbers (DEFAULT_DUCK). */
  duckSettings?: DuckSettings
  /** Timbre, dynamics and volume curve; absent = track as it is. */
  fx?: TrackFx
  /** Second OF THE FILE at which the sound starts (cut at the beginning). */
  offset?: number
  /** Repeats the file until the end of the stretch. */
  loop?: boolean
}

export interface MotionAudioMixSpec {
  /** Video ALREADY assembled (the single segment, or the concatenation of the tracks). */
  video: string
  output: string
  duration: number
  format: MotionFormat
  events: MotionAudioEvent[]
  /** Finishing of the whole mix (peak ceiling, delivery loudness). */
  master?: MasterFx | null
}

/**
 * The simple case — one track, the whole piece, no processing — has its own
 * path (`motionAudioFfmpegArgs`): one more `-i`, no filter graph. Worth
 * keeping both because the graph only pays off when there is something to mix.
 */
export function isPlainAudioEvent(event: MotionAudioEvent): boolean {
  return (
    event.start === 0 &&
    event.end === undefined &&
    event.gainDb === 0 &&
    event.fadeIn === 0 &&
    event.fadeOut === 0 &&
    !event.duck &&
    !event.offset &&
    !event.loop &&
    !hasTrackFx(event.fx)
  )
}

/**
 * The simple path only works when NOTHING touches the sound: neither the track (isPlainAudioEvent),
 * nor the mix finishing. A peak ceiling on a single track still needs the graph.
 */
export function isPlainAudioMix(events: MotionAudioEvent[], master?: MasterFx | null): boolean {
  return events.length === 1 && isPlainAudioEvent(events[0]) && !hasMasterFx(master)
}

/**
 * The final pass when there is MIXING: each track is trimmed, gets level and ramps,
 * is placed at its instant (`adelay`) and the beds (`duck: true`) go down by themselves
 * under the front tracks (`sidechaincompress`) before the sum.
 *
 * Two details that decide the result:
 *
 *  - `normalize=0` in `amix` is mandatory. By default `amix` DIVIDES by the number
 *    of inputs, and the narration would come out lower just because there is music — the level
 *    the manifest asks for is the level that comes out;
 *  - `duration` of `amix` stays at the default (`longest`), and NOT at the `duration=first` of
 *    the EDL render: there the voice is the first input and rules the length, here the
 *    first track may be a half-second effect, and the mix cannot end
 *    with it. Whoever rules the length is still the piece's `-t`.
 *
 * The duck trigger is the sum of the front tracks: the bed goes down when ANY
 * voice or effect is playing, which is what one expects from "background music".
 */
/**
 * "Separate audio": the file carries the video with sound and the person wants the track
 * alone too (to edit outside or reuse the narration). Extracting from the
 * FINAL file is a single pass, without re-encoding picture and without remixing: the WAV comes out
 * with exactly the sound that is in the video — mixed, cut and normalized the same way.
 * 16-bit PCM at 48 kHz is what any editor opens without complaining.
 */
export function audioExtractFfmpegArgs(spec: { video: string; output: string }): string[] {
  return ['-v', 'error', '-i', spec.video, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', spec.output]
}

export function motionAudioMixFfmpegArgs(spec: MotionAudioMixSpec): string[] {
  const graph: string[] = []
  const labels = spec.events.map((event, index) => {
    const out = `t${index}`
    const chain: string[] = []
    // Length of the stretch on the track's OWN timeline: with `end`, it is the
    // trim; without it, what remains of the piece after `start` — it is where the out
    // ramp has to start.
    const length = event.end === undefined ? spec.duration - event.start : event.end - event.start
    const offset = event.offset ?? 0
    // A short file that repeats is infinite: without the trim the mix would have no end.
    if (event.loop) chain.push('aloop=loop=-1:size=2147483647')
    if (offset > 0) {
      // Cut at the beginning: the sound starts from `offset`, and the track's clock goes back to zero
      // so the delay (adelay) counts from it.
      const end = event.end !== undefined || event.loop ? `:end=${(offset + Math.max(0, length)).toFixed(3)}` : ''
      chain.push(`atrim=start=${offset.toFixed(3)}${end}`, 'asetpts=PTS-STARTPTS')
    } else if (event.end !== undefined || event.loop) {
      chain.push(`atrim=end=${Math.max(0, length).toFixed(3)}`)
    }
    // Timbre and dynamics before the level: the compressor reacts to the signal as the track
    // is, and the gain (and the ramps) come on top of the result.
    if (event.fx) chain.push(...toneFilters(event.fx))
    if (event.gainDb !== 0) chain.push(`volume=${event.gainDb.toFixed(2)}dB`)
    if (event.fadeIn > 0) chain.push(`afade=in:st=0:d=${event.fadeIn.toFixed(3)}`)
    if (event.fadeOut > 0) {
      chain.push(`afade=out:st=${Math.max(0, length - event.fadeOut).toFixed(3)}:d=${event.fadeOut.toFixed(3)}`)
    }
    // `all=1` covers mono and stereo without needing to know how many channels the file has.
    if (event.start > 0) chain.push(`adelay=${Math.round(event.start * 1000)}:all=1`)
    // `atrim=start` followed by `adelay` makes ffmpeg lose the delay's silence
    // when the result goes to mp4/aac (the sound shows up early, and the track comes out
    // shorter). The `atrim=end` + `adelay` from before does not suffer from that; the
    // initial cut does. The timestamp-based resample gives the whole delay back.
    if (offset > 0 && event.start > 0) chain.push('aresample=async=1:first_pts=0')
    // The volume curve after the delay: there the filter's `t` is already the
    // PIECE's time, which is the ruler in which the manifest writes the points.
    const curve = event.fx ? automationFilter(event.fx.automation) : null
    if (curve) chain.push(curve)
    // Empty chain (raw track: nothing to trim, no level, no ramp)
    // needs a filter anyway — `[1:a][t0]` without a filter between the labels is
    // an invalid graph, and ffmpeg answers "No such filter: ''". `anull` is the
    // pass-through.
    graph.push(`[${index + 1}:a]${(chain.length ? chain : ['anull']).join(',')}[${out}]`)
    return out
  })

  const front = spec.events.flatMap((event, index) => (event.duck ? [] : [labels[index]]))
  const bed = spec.events.flatMap((event, index) => (event.duck ? [labels[index]] : []))
  const sum = (inputs: string[], out: string): void => {
    graph.push(`[${inputs.join('][')}]amix=inputs=${inputs.length}:normalize=0:dropout_transition=0[${out}]`)
  }

  let output = labels[0]
  if (labels.length === 1) {
    // A single track: its chain is already the output, there is nothing to sum.
  } else if (front.length === 0 || bed.length === 0) {
    // Without both families there is no duck to do: it is the sum of all.
    output = 'mix'
    sum(labels, output)
  } else {
    // The front triggers the duck: one copy of it goes to the sum, another to the trigger.
    // Same assembly and same parameters as the EDL render (render.ts:246).
    sum(front, 'front')
    graph.push('[front]asplit=2[frontmix][frontsc]')
    sum(bed, 'bed')
    // The duck numbers come from the first bed that customized them (all beds
    // are summed BEFORE going through the trigger, so there is only one duck).
    const settings = spec.events.find((event) => event.duck && event.duckSettings)?.duckSettings ?? DEFAULT_DUCK
    graph.push(`[bed][frontsc]${duckFilter(settings)}[bedducked]`)
    output = 'mix'
    sum(['bedducked', 'frontmix'], output)
  }

  const finish = masterFilters(spec.master)
  if (finish.length > 0) {
    graph.push(`[${output}]${finish.join(',')}[master]`)
    output = 'master'
  }

  return [
    '-v', 'error',
    '-i', spec.video,
    ...spec.events.flatMap((event) => ['-i', event.file]),
    '-filter_complex', graph.join(';'),
    '-map', '0:v:0',
    '-map', `[${output}]`,
    '-c:v', 'copy',
    ...motionAudioCodec(spec.format),
    '-t', spec.duration.toFixed(3),
    ...(spec.format === 'mp4' ? ['-movflags', '+faststart'] : []),
    spec.output,
  ]
}
