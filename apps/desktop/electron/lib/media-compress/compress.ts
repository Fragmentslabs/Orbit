import fsp from 'node:fs/promises'
import path from 'node:path'
import { probeMedia, runFfmpeg, type MediaProbe } from '../video/ffmpeg'
import {
  buildPlan,
  defaultContainer,
  nextVideoBitrate,
  type CompressTarget,
  type EncodePlan,
  type MediaCodec,
  type MediaContainer,
  type OutputKind,
  type Preset,
} from './plan'

/**
 * Compressão de mídia com alvo conferido — a parte que TOCA o disco.
 *
 * O contrato é o oposto do "roda ffmpeg e torce": o arquivo de entrada nunca é
 * tocado, o resultado é reaberto com ffprobe e comparado com a origem (tamanho,
 * duração, streams) e, quando o alvo é um teto em bytes, o encoder é refeito com
 * o bitrate corrigido — no máximo três tentativas, sempre medindo o que saiu.
 *
 * Escreve num arquivo temporário e só renomeia no fim: um encode interrompido
 * (abort, erro do ffmpeg) não deixa um .mp4 pela metade com nome de definitivo.
 */

/** Tentativas máximas no modo tamanho-alvo (1 + 2 correções). */
export const MAX_ATTEMPTS = 3

export interface CompressRequest {
  file: string
  /** Caminho final do arquivo comprimido (nunca igual ao de entrada). */
  output: string
  target: CompressTarget
  format?: MediaContainer
  codec?: MediaCodec
  stripAudio?: boolean
  audioBitrate?: number
  preset?: Preset
  /** Recodifica mesmo quando o arquivo já cabe no alvo. */
  force?: boolean
  signal?: AbortSignal
}

export interface CompressReport {
  output: string
  kind: OutputKind
  before: MediaProbe
  after: MediaProbe
  plan: EncodePlan
  attempts: number
  encodeMs: number
  notes: string[]
  /** O teto em bytes foi cumprido? */
  withinTarget: boolean
  /** Nada foi recodificado: o arquivo já cabia no alvo. */
  skipped: boolean
}

const ENCODERS: Record<string, string> = {
  h264: 'libx264',
  hevc: 'libx265',
  av1: 'libsvtav1',
  vp9: 'libvpx-vp9',
  aac: 'aac',
  mp3: 'libmp3lame',
  opus: 'libopus',
}

const X264_PRESET: Record<Preset, string> = { fast: 'veryfast', balanced: 'medium', slow: 'slow' }
const SVT_PRESET: Record<Preset, string> = { fast: '10', balanced: '8', slow: '6' }

function audioEncoderArgs(plan: EncodePlan): string[] {
  const args = ['-c:a', ENCODERS[plan.audioCodec], '-b:a', `${plan.audioBitrate}k`]
  // Opus em .opus/.webm; o resto é estereofônico de consumo.
  if (plan.audioCodec !== 'opus') args.push('-ac', '2')
  return args
}

function videoEncoderArgs(plan: EncodePlan): string[] {
  const codec = plan.videoCodec!
  const args = ['-c:v', ENCODERS[codec]]

  if (codec === 'h264' || codec === 'hevc') args.push('-preset', X264_PRESET[plan.preset])
  if (codec === 'hevc') {
    // hvc1 = o que o QuickTime/Safari tocam; e o libx265 é verborrágico no stderr.
    args.push('-tag:v', 'hvc1', '-x265-params', 'log-level=error')
  }
  if (codec === 'vp9') args.push('-row-mt', '1', '-cpu-used', plan.preset === 'fast' ? '4' : '2')
  if (codec === 'av1') args.push('-preset', SVT_PRESET[plan.preset])

  if (plan.crf !== null) {
    args.push('-crf', String(plan.crf))
    // VP9 em CRF precisa do bitrate zerado, senão ele tenta as duas coisas.
    if (codec === 'vp9') args.push('-b:v', '0')
  } else if (plan.bitrate) {
    // Bitrate-alvo é uma PROMESSA de tamanho: maxrate impede o pico de estourar.
    args.push('-b:v', `${plan.bitrate}k`, '-maxrate', `${plan.bitrate}k`, '-bufsize', `${plan.bitrate * 2}k`)
  }
  return args
}

/** Argumentos completos do ffmpeg para um plano. Puro — o teste usa isto. */
export function buildFfmpegArgs(input: string, output: string, plan: EncodePlan): string[] {
  const args = ['-v', 'error', '-i', input]

  if (plan.kind === 'audio') {
    args.push('-vn', '-map', '0:a:0', ...audioEncoderArgs(plan))
  } else {
    args.push('-map', '0:v:0')
    if (plan.stripAudio) args.push('-an')
    else args.push('-map', '0:a:0?')

    const filters: string[] = []
    if (plan.height) filters.push(`scale=-2:${plan.height}`)
    if (plan.fps) filters.push(`fps=${plan.fps}`)
    if (filters.length) args.push('-vf', filters.join(','))

    args.push(...videoEncoderArgs(plan))
    if (!plan.stripAudio) args.push(...audioEncoderArgs(plan))
  }

  if (plan.pixFmt) args.push('-pix_fmt', plan.pixFmt)
  // Metadados de origem (data, título, faixa) sobrevivem; legendas embutidas e
  // trilhas de dados não — elas não fazem sentido no arquivo comprimido.
  args.push('-map_metadata', '0', '-sn', '-dn')
  if (plan.container === 'mp4' || plan.container === 'mov' || plan.container === 'm4a') {
    // Índice na frente: toca/streama antes de baixar inteiro.
    args.push('-movflags', '+faststart')
  }
  args.push(output)
  return args
}

function tempPath(output: string, attempt: number): string {
  const ext = path.extname(output)
  const base = ext ? output.slice(0, -ext.length) : output
  return `${base}.part${attempt}${ext}`
}

function durationAgrees(before: MediaProbe, after: MediaProbe): boolean {
  if (!before.durationMs || !after.durationMs) return false
  return Math.abs(after.durationMs - before.durationMs) <= Math.max(600, before.durationMs * 0.02)
}

/**
 * Comprime (ou extrai o áudio) um arquivo de mídia.
 *
 * O `output` é escrito POR ESTA função: o chamador não deve ter já o arquivo
 * aberto nem apontá-lo para a entrada.
 */
export async function compressMedia(req: CompressRequest): Promise<CompressReport> {
  const input = path.resolve(req.file)
  const output = path.resolve(req.output)
  if (input === output) throw new Error('the output cannot be the source file — compression never overwrites the original')

  const before = await probeMedia(input)
  if (!before.durationMs) {
    throw new Error(`could not read the duration of ${path.basename(input)} — ffprobe found no timing information`)
  }
  if (!before.video.length && !before.audio.length) {
    throw new Error(`${path.basename(input)} has no audio or video stream`)
  }
  const sourceKind: OutputKind = before.video.length ? 'video' : 'audio'

  const container = req.format ?? defaultContainer(before, sourceKind)
  const justFitsInBytes =
    Boolean(req.target.maxBytes) &&
    !req.target.quality &&
    !req.target.bitrate &&
    !req.target.height &&
    !req.target.fps &&
    !req.format &&
    !req.codec &&
    !req.stripAudio

  // Já cabe no teto e nada mais foi pedido: recomprimir só perderia qualidade.
  if (justFitsInBytes && before.sizeBytes <= req.target.maxBytes! && !req.force) {
    return {
      output,
      kind: sourceKind,
      before,
      after: before,
      plan: buildPlan({ probe: before, target: req.target, container, codec: req.codec, stripAudio: req.stripAudio, audioBitrate: req.audioBitrate, preset: req.preset }),
      attempts: 0,
      encodeMs: 0,
      notes: ['the file already fits the target — nothing was re-encoded'],
      withinTarget: true,
      skipped: true,
    }
  }

  let plan = buildPlan({
    probe: before,
    target: req.target,
    container,
    codec: req.codec,
    stripAudio: req.stripAudio,
    audioBitrate: req.audioBitrate,
    preset: req.preset,
  })

  await fsp.mkdir(path.dirname(output), { recursive: true })
  const started = Date.now()
  let attempts = 0
  let after = before
  let tmp = ''

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1
    tmp = tempPath(output, attempts)
    try {
      await runFfmpeg(buildFfmpegArgs(input, tmp, plan), {
        signal: req.signal,
        durationMs: before.durationMs,
      })
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      throw err
    }
    after = await probeMedia(tmp)

    const overTarget = Boolean(req.target.maxBytes) && after.sizeBytes > req.target.maxBytes!
    const canCorrect = plan.bitrate !== null && plan.crf === null && attempts < MAX_ATTEMPTS
    if (overTarget && canCorrect) {
      plan = { ...plan, bitrate: nextVideoBitrate(plan.bitrate!, after.sizeBytes, req.target.maxBytes!) }
      await fsp.rm(tmp, { force: true })
      continue
    }
    break
  }

  const notes = [...plan.notes]
  if (!durationAgrees(before, after)) {
    notes.push(
      `duration changed (${(before.durationMs / 1000).toFixed(2)} s → ${(after.durationMs / 1000).toFixed(2)} s) — check the file before using it`,
    )
  }
  if (plan.kind === 'video' && !after.video.length) {
    throw new Error('the encode produced no video stream — nothing was written')
  }
  if (!after.audio.length && (!plan.stripAudio || plan.kind === 'audio')) {
    notes.push('the output has no audio stream')
  }

  await fsp.rename(tmp, output)
  const withinTarget = !req.target.maxBytes || after.sizeBytes <= req.target.maxBytes
  if (!withinTarget) {
    notes.push(
      `even at the bitrate floor the file is ${(after.sizeBytes / 1e6).toFixed(1)} MB — above the requested ${(req.target.maxBytes! / 1e6).toFixed(1)} MB`,
    )
  }

  return {
    output,
    kind: plan.kind,
    before,
    // O probe é do temporário, mas o arquivo é o MESMO bytes: só o nome muda.
    after: { ...after, file: output },
    plan,
    attempts,
    encodeMs: Date.now() - started,
    notes,
    withinTarget,
    skipped: false,
  }
}
