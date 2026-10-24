import type { MediaProbe } from '../video/ffmpeg'

/**
 * Planejamento da compressão de áudio e vídeo — PURO.
 *
 * O problema que este módulo resolve não é "rodar ffmpeg": é traduzir o que o
 * usuário pede ("cabe em 25 MB", "qualidade boa", "720p") nas decisões que o
 * encoder precisa — codec, contêiner, CRF ou bitrate, faixa de áudio, cor —
 * sem depender de o modelo lembrar das armadilhas de cada formato.
 *
 * Duas famílias de alvo, e a diferença importa:
 *   - QUALIDADE (crf): uma passada, o tamanho é consequência;
 *   - TAMANHO (maxBytes): o tamanho é a promessa, então a conta começa pelo
 *     orçamento de bits por segundo e o encoder é CBR-ish (b:v + maxrate). Se
 *     ainda estourar, `nextVideoBitrate` corrige e o compress.ts tenta de novo.
 */

export type VideoCodec = 'h264' | 'hevc' | 'av1' | 'vp9'
export type AudioCodec = 'aac' | 'mp3' | 'opus'
export type MediaCodec = VideoCodec | AudioCodec
export type MediaContainer = 'mp4' | 'mov' | 'webm' | 'mkv' | 'm4a' | 'mp3' | 'opus' | 'ogg'
/** O que SAI: um contêiner de áudio num vídeo significa extrair o áudio. */
export type OutputKind = 'video' | 'audio'
export type Preset = 'fast' | 'balanced' | 'slow'

/** O que o usuário pediu. Sem nenhum campo, vale qualidade 75. */
export interface CompressTarget {
  /** Teto em bytes — a promessa é o tamanho final. */
  maxBytes?: number
  /** 1..100 — atalho para CRF (vídeo) ou bitrate (áudio). */
  quality?: number
  /** kbps do fluxo principal (vídeo em contêiner de vídeo, áudio no resto). */
  bitrate?: number
  /** Altura de saída; nunca aumenta o vídeo. */
  height?: number
  /** fps de saída; nunca aumenta o fps. */
  fps?: number
}

interface ContainerSpec {
  kind: OutputKind
  video?: VideoCodec
  audio: AudioCodec
  /** Codecs de vídeo que o contêiner aceita num override explícito. */
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

/** Folga para o contêiner (índices, metadados, cabeçalhos). */
export const SIZE_SAFETY = 0.97
/** Abaixo disto o vídeo fica impraticável; o alvo é fisicamente impossível. */
export const MIN_VIDEO_KBPS = 60

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function containerKind(container: MediaContainer): OutputKind {
  return CONTAINERS[container].kind
}

/**
 * Contêiner padrão quando o usuário não escolhe: o de origem quando ele já é
 * um formato comprimido conhecido (não faz sentido virar mp4 o que já era mp3),
 * senão o mais compatível da família.
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
 * Contêiner + codec explícitos → o par que o ffmpeg aceita, ou um erro que diz
 * o que é válido. Sem codec explícito vale o padrão do contêiner.
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

/** 1..100 → CRF. Base 18 (quase sem perda) e ~0,28 por ponto perdido. */
export function qualityToCrf(quality: number, codec: VideoCodec): number {
  const q = clamp(Math.round(quality), 1, 100)
  const base = 18 + (100 - q) * 0.28
  // x265/vp9/av1 usam escalas diferentes para a MESMA qualidade percebida.
  const offset = codec === 'hevc' ? 5 : codec === 'vp9' ? 8 : codec === 'av1' ? 10 : 0
  const ceiling = codec === 'h264' || codec === 'hevc' ? 51 : 63
  return clamp(Math.round(base + offset), 16, ceiling)
}

/** 1..100 → kbps de áudio. Opus entrega o mesmo com metade da taxa. */
export function qualityToAudioBitrate(quality: number, codec: AudioCodec): number {
  const q = clamp(Math.round(quality), 1, 100)
  if (codec === 'opus') return q >= 90 ? 192 : q >= 70 ? 128 : q >= 50 ? 96 : q >= 30 ? 80 : 64
  return q >= 90 ? 256 : q >= 70 ? 192 : q >= 50 ? 160 : q >= 30 ? 128 : q >= 15 ? 112 : 96
}

/** kbps médio do arquivo inteiro (vídeo+áudio) — teto do que não vale inflar. */
export function estimateBitrateKbps(sizeBytes: number, durationMs: number): number {
  if (durationMs <= 0) return 0
  return Math.round((sizeBytes * 8) / (durationMs / 1000) / 1000)
}

/** Orçamento total de bits de um alvo em bytes. */
export function totalBudgetKbps(maxBytes: number, durationMs: number): number {
  if (durationMs <= 0) throw new Error('cannot budget a target without a known duration')
  return Math.max(24, (maxBytes * 8 * SIZE_SAFETY) / (durationMs / 1000) / 1000)
}

/**
 * Bits do vídeo = orçamento − áudio − folga do contêiner, limitado ao bitrate
 * de origem (comprimir não deve INFLAR o arquivo) e a um piso praticável.
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

/** kbps de áudio que cabem num alvo em bytes (extração de áudio). */
export function audioBitrateForTarget(maxBytes: number, durationMs: number, codec: AudioCodec): number {
  const total = totalBudgetKbps(maxBytes, durationMs)
  const floor = codec === 'opus' ? 32 : 64
  const ceiling = codec === 'opus' ? 256 : 320
  return clamp(Math.floor(total - 2), floor, ceiling)
}

/**
 * Corrige o bitrate depois de uma tentativa que estourou o alvo: escala pelo
 * quanto passou e guarda 4% de margem. Puro — é o laço do compress.ts.
 */
export function nextVideoBitrate(prevKbps: number, actualBytes: number, maxBytes: number): number {
  const ratio = maxBytes / Math.max(1, actualBytes)
  return Math.max(MIN_VIDEO_KBPS, Math.floor(prevKbps * ratio * 0.96))
}

export interface EncodePlan {
  /** O que sai. */
  kind: OutputKind
  container: MediaContainer
  videoCodec: VideoCodec | null
  audioCodec: AudioCodec
  /** CRF quando o alvo é qualidade; null no modo bitrate. */
  crf: number | null
  /** kbps do vídeo (ou do áudio, em saída só de áudio). */
  bitrate: number | null
  /** kbps do áudio; 0 remove a faixa. */
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

/** Par mais próximo ABAIXO: arredondar para cima poderia ampliar o vídeo. */
function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

const TEN_BIT = /10le|10be|p010|p016/

/**
 * Monta o plano completo. É AQUI que as armadilhas viram decisão: 10 bits,
 * alvo impossível, downscale pedido maior que a origem, vídeo sem áudio.
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
      // O áudio não pode comer o orçamento: num alvo apertado ele desce junto.
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

  // Downscale/fps só descem: pedir 1080p de um 720p não é comprimir, é inflar.
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

  // 10 bits: H.264 é 8 bits — e converter sem tone mapping lava a cor. Em
  // HEVC/AV1/VP9 o perfil de 10 bits é suportado, então o arquivo mantém o que
  // tinha. A decisão fica no plano, não no improviso de quem chamou.
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
