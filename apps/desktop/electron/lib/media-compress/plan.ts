import type { MediaProbe } from '../video/ffmpeg'

/**
 * Planning of audio and video compression — PURE.
 *
 * The problem this module solves is not "run ffmpeg": it is translating what the
 * user asks for ("fits in 25 MB", "good quality", "720p") into the decisions the
 * encoder needs — codec, container, CRF or bitrate, audio track, color — without
 * depending on the model remembering the pitfalls of each format.
 *
 * Two families of target, and the difference matters:
 *   - QUALITY (crf): one pass, the size is a consequence;
 *   - SIZE (maxBytes): the size is the promise, so the math starts from the bit
 *     budget per second and the encoder is CBR-ish (b:v + maxrate). If it still
 *     overshoots, `nextVideoBitrate` corrects it and compress.ts tries again.
 */

export type VideoCodec = 'h264' | 'hevc' | 'av1' | 'vp9'
export type AudioCodec = 'aac' | 'mp3' | 'opus'
export type MediaCodec = VideoCodec | AudioCodec
export type MediaContainer = 'mp4' | 'mov' | 'webm' | 'mkv' | 'm4a' | 'mp3' | 'opus' | 'ogg'
/** What comes OUT: an audio container on a video means extracting the audio. */
export type OutputKind = 'video' | 'audio'
export type Preset = 'fast' | 'balanced' | 'slow'

/** What the user asked for. With no field at all, quality 75 applies. */
export interface CompressTarget {
  /** Ceiling in bytes — the promise is the final size. */
  maxBytes?: number
  /** 1..100 — a shortcut for CRF (video) or bitrate (audio). */
  quality?: number
  /** kbps of the main stream (video in a video container, audio in the rest). */
  bitrate?: number
  /** Output height; never upscales the video. */
  height?: number
  /** Output fps; never raises the fps. */
  fps?: number
}

interface ContainerSpec {
  kind: OutputKind
  video?: VideoCodec
  audio: AudioCodec
  /** Video codecs the container accepts on an explicit override. */
  videoCodecs?: VideoCodec[]
}

const CONTAINERS: Record<MediaContainer, ContainerSpec> = {
  mp4: { kind: 'video', video: 'h264', audio: 'aac', videoCodecs: ['h264', 'hevc', 'av1'] },
  mov: { kind: 'video', video: 'h264', audio: 'aac', videoCodecs: ['h264', 'hevc'] },
  webm: { kind: 'video', video: 'vp9', audio: 'opus', videoCodecs: ['vp9', 'av1'] },
  mkv: { kind: 'video', video: 'h264', audio: 'aac', videoCodecs: ['h264', 'hevc', 'av1', 'vp9'] },
  m4a: { kind: 'audio', audio: 'aac' },
  mp3: { kind: 'audio', audio: 'mp3' },
  opus: { kind: 'audio', audio: 'opus' },
  ogg: { kind: 'audio', audio: 'opus' },
}

export const AUDIO_CONTAINERS: readonly MediaContainer[] = ['m4a', 'mp3', 'opus', 'ogg']
export const VIDEO_CONTAINERS: readonly MediaContainer[] = ['mp4', 'mov', 'webm', 'mkv']

/** Slack for the container (indices, metadata, headers). */
export const SIZE_SAFETY = 0.97
/** Below this the video becomes impractical; the target is physically impossible. */
export const MIN_VIDEO_KBPS = 60

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function containerKind(container: MediaContainer): OutputKind {
  return CONTAINERS[container].kind
}

/**
 * Default container when the user does not choose: the source one when it already
 * is a known compressed format (turning what was already an mp3 into an mp4 makes
 * no sense), otherwise the most compatible one of the family.
 */
export function defaultContainer(probe: MediaProbe, kind: OutputKind): MediaContainer {
  if (kind === 'audio') {
    const codec = probe.audio[0]?.codec
    if (codec === 'mp3') return 'mp3'
    if (codec === 'opus') return 'opus'
    if (codec === 'vorbis') return 'ogg'
    return 'm4a'
  }
  return probe.format.includes('webm') ? 'webm' : 'mp4'
}

export interface ResolvedCodecs {
  kind: OutputKind
  container: MediaContainer
  videoCodec: VideoCodec | null
  audioCodec: AudioCodec
}

/**
 * Explicit container + codec → the pair ffmpeg accepts, or an error that says what
 * is valid. Without an explicit codec, the container default applies.
 */
export function resolveCodecs(container: MediaContainer, codec?: MediaCodec): ResolvedCodecs {
  const spec = CONTAINERS[container]
  if (!spec) throw new Error(`unsupported container: ${container} (valid: ${Object.keys(CONTAINERS).join(', ')})`)
  if (!codec) return { kind: spec.kind, container, videoCodec: spec.video ?? null, audioCodec: spec.audio }

  if (spec.kind === 'audio') {
    if (codec !== spec.audio) {
      throw new Error(
        `${container} carries ${spec.audio} audio, not ${codec}. For ${codec} use ${
          codec === 'aac' ? 'm4a' : codec === 'mp3' ? 'mp3' : 'opus'
        }.`,
      )
    }
    return { kind: 'audio', container, videoCodec: null, audioCodec: spec.audio }
  }

  const videoCodecs = spec.videoCodecs ?? [spec.video!]
  if (!videoCodecs.includes(codec as VideoCodec)) {
    throw new Error(
      `${container} carries video ${videoCodecs.join('/')}, not ${codec}. ` +
        `For ${codec} use ${codec === 'vp9' ? 'webm' : codec === 'av1' ? 'webm or mp4' : 'mp4'}.`,
    )
  }
  return { kind: 'video', container, videoCodec: codec as VideoCodec, audioCodec: spec.audio }
}

/** 1..100 → CRF. Base 18 (almost lossless) and ~0.28 per point lost. */
export function qualityToCrf(quality: number, codec: VideoCodec): number {
  const q = clamp(Math.round(quality), 1, 100)
  const base = 18 + (100 - q) * 0.28
  // x265/vp9/av1 use different scales for the SAME perceived quality.
  const offset = codec === 'hevc' ? 5 : codec === 'vp9' ? 8 : codec === 'av1' ? 10 : 0
  const ceiling = codec === 'h264' || codec === 'hevc' ? 51 : 63
  return clamp(Math.round(base + offset), 16, ceiling)
}

/** 1..100 → audio kbps. Opus delivers the same at half the rate. */
export function qualityToAudioBitrate(quality: number, codec: AudioCodec): number {
  const q = clamp(Math.round(quality), 1, 100)
  if (codec === 'opus') return q >= 90 ? 192 : q >= 70 ? 128 : q >= 50 ? 96 : q >= 30 ? 80 : 64
  return q >= 90 ? 256 : q >= 70 ? 192 : q >= 50 ? 160 : q >= 30 ? 128 : q >= 15 ? 112 : 96
}

/** Average kbps of the whole file (video+audio) — the ceiling of what is not worth inflating. */
export function estimateBitrateKbps(sizeBytes: number, durationMs: number): number {
  if (durationMs <= 0) return 0
  return Math.round((sizeBytes * 8) / (durationMs / 1000) / 1000)
}

/** Total bit budget of a target in bytes. */
export function totalBudgetKbps(maxBytes: number, durationMs: number): number {
  if (durationMs <= 0) throw new Error('cannot budget a target without a known duration')
  return Math.max(24, (maxBytes * 8 * SIZE_SAFETY) / (durationMs / 1000) / 1000)
}

/**
 * Video bits = budget − audio − container slack, capped at the source bitrate
 * (compressing must not INFLATE the file) and at a workable floor.
 */
export function videoBitrateForTarget(input: {
  maxBytes: number
  durationMs: number
  audioKbps: number
  sourceKbps?: number
}): number {
  const total = totalBudgetKbps(input.maxBytes, input.durationMs)
  const raw = Math.floor(total - input.audioKbps - 6)
  const capped =
    input.sourceKbps && input.sourceKbps > 0 ? Math.min(raw, Math.max(120, Math.ceil(input.sourceKbps))) : raw
  return Math.max(MIN_VIDEO_KBPS, capped)
}

/** Audio kbps that fit in a target in bytes (audio extraction). */
export function audioBitrateForTarget(maxBytes: number, durationMs: number, codec: AudioCodec): number {
  const total = totalBudgetKbps(maxBytes, durationMs)
  const floor = codec === 'opus' ? 32 : 64
  const ceiling = codec === 'opus' ? 256 : 320
  return clamp(Math.floor(total - 2), floor, ceiling)
}

/**
 * Corrects the bitrate after an attempt that overshot the target: it scales by how
 * much it went over and keeps 4% of margin. Pure — it is the loop of compress.ts.
 */
export function nextVideoBitrate(prevKbps: number, actualBytes: number, maxBytes: number): number {
  const ratio = maxBytes / Math.max(1, actualBytes)
  return Math.max(MIN_VIDEO_KBPS, Math.floor(prevKbps * ratio * 0.96))
}

export interface EncodePlan {
  /** What comes out. */
  kind: OutputKind
  container: MediaContainer
  videoCodec: VideoCodec | null
  audioCodec: AudioCodec
  /** CRF when the target is quality; null in bitrate mode. */
  crf: number | null
  /** kbps of the video (or of the audio, on audio-only output). */
  bitrate: number | null
  /** Audio kbps; 0 removes the track. */
  audioBitrate: number
  height: number | null
  fps: number | null
  stripAudio: boolean
  pixFmt: string | null
  preset: Preset
  notes: string[]
}

export interface PlanInput {
  probe: MediaProbe
  target: CompressTarget
  container?: MediaContainer
  codec?: MediaCodec
  stripAudio?: boolean
  audioBitrate?: number
  preset?: Preset
}

/** Nearest pair BELOW: rounding up could enlarge the video. */
function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

const TEN_BIT = /10le|10be|p010|p016/

/**
 * Builds the complete plan. It is HERE that the pitfalls turn into a decision: 10 bit,
 * impossible target, downscale requested larger than the source, video without
 * audio.
 */
export function buildPlan(input: PlanInput): EncodePlan {
  const { probe, target } = input
  const notes: string[] = []
  const hasVideo = probe.video.length > 0
  const hasAudio = probe.audio.length > 0

  const container = input.container ?? defaultContainer(probe, hasVideo ? 'video' : 'audio')
  const codecs = resolveCodecs(container, input.codec)
  if (codecs.kind === 'video' && !hasVideo) {
    throw new Error('the output is a video but the source has no video stream')
  }
  if (codecs.kind === 'audio' && !hasAudio) {
    throw new Error('the source has no audio stream to compress')
  }
  if (codecs.kind === 'audio' && hasVideo) {
    notes.push('audio only: the video stream was dropped')
  }

  const quality = target.quality ?? 75
  const preset = input.preset ?? 'balanced'
  let stripAudio = input.stripAudio ?? !hasAudio
  let audioBitrate = stripAudio ? 0 : input.audioBitrate ?? qualityToAudioBitrate(quality, codecs.audioCodec)

  let crf: number | null = null
  let bitrate: number | null = null

  if (codecs.kind === 'video') {
    const sourceKbps = estimateBitrateKbps(probe.sizeBytes, probe.durationMs)
    if (target.maxBytes) {
      // Audio cannot eat the budget: in a tight target it goes down along with the rest.
      const total = totalBudgetKbps(target.maxBytes, probe.durationMs)
      if (!stripAudio && audioBitrate > total * 0.35) {
        audioBitrate = Math.max(codecs.audioCodec === 'opus' ? 48 : 64, Math.floor(total * 0.3))
        notes.push(`audio lowered to ${audioBitrate} kbps so the video keeps the bulk of the budget`)
      }
      bitrate = videoBitrateForTarget({
        maxBytes: target.maxBytes,
        durationMs: probe.durationMs,
        audioKbps: stripAudio ? 0 : audioBitrate,
        sourceKbps,
      })
      if (bitrate === MIN_VIDEO_KBPS) {
        notes.push(`the target is tight for ${Math.round(probe.durationMs / 1000)} s: the video is at the ${MIN_VIDEO_KBPS} kbps floor and may still exceed it`)
      }
    } else if (target.bitrate) {
      bitrate = Math.max(MIN_VIDEO_KBPS, Math.round(target.bitrate))
    } else {
      crf = qualityToCrf(quality, codecs.videoCodec!)
    }
  } else {
    if (target.maxBytes) {
      audioBitrate = audioBitrateForTarget(target.maxBytes, probe.durationMs, codecs.audioCodec)
      bitrate = audioBitrate
    } else if (target.bitrate) {
      audioBitrate = Math.round(target.bitrate)
      bitrate = audioBitrate
    } else {
      audioBitrate = qualityToAudioBitrate(quality, codecs.audioCodec)
      bitrate = audioBitrate
    }
    stripAudio = false
  }

  // Downscale/fps only go down: asking 1080p out of a 720p is not compressing, it is inflating.
  let height: number | null = null
  const displayHeight = probe.display?.height ?? 0
  if (target.height && displayHeight) {
    if (target.height < displayHeight) height = even(target.height)
    else notes.push(`height ${target.height}p ignored: the source is already ${displayHeight}p`)
  }
  let fps: number | null = null
  const sourceFps = probe.video[0]?.fps ?? 0
  if (target.fps && sourceFps) {
    if (target.fps < sourceFps) fps = target.fps
    else notes.push(`${target.fps} fps ignored: the source is already ${sourceFps} fps`)
  }

  // 10 bit: H.264 is 8 bit — and converting without tone mapping washes the color out. In
  // HEVC/AV1/VP9 the 10-bit profile is supported, so the file keeps what it
  // had. The decision stays in the plan, not in the improvisation of the caller.
  const sourcePixFmt = probe.video[0]?.pixFmt ?? ''
  let pixFmt: string | null = null
  if (codecs.kind === 'video') {
    const tenBit = TEN_BIT.test(sourcePixFmt)
    if (tenBit && codecs.videoCodec === 'h264') {
      pixFmt = 'yuv420p'
      notes.push(`${sourcePixFmt} source converted to 8-bit H.264 without tone mapping — colours may shift; use codec hevc/av1 to keep 10 bits`)
    } else if (tenBit) {
      pixFmt = 'yuv420p10le'
    } else {
      pixFmt = 'yuv420p'
    }
  }

  return {
    kind: codecs.kind,
    container,
    videoCodec: codecs.videoCodec,
    audioCodec: codecs.audioCodec,
    crf,
    bitrate,
    audioBitrate,
    height,
    fps,
    stripAudio,
    pixFmt,
    preset,
    notes,
  }
}
