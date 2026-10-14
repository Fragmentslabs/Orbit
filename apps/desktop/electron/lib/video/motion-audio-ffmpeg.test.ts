import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * O MUX do áudio da peça com o ffmpeg de verdade. O vídeo sai do mesmo caminho
 * rawvideo do render (quadros crus no stdin) e o som entra numa passada final —
 * só que aqui não há captura de janela, então dá para conferir de ponta a ponta
 * o que os argumentos sozinhos não provam:
 *
 *   1. o comprimento é o da COMPOSIÇÃO, não o do áudio;
 *   2. um áudio mais curto NÃO encurta o vídeo (é o que `-shortest` faria, e é o
 *      reflexo que este teste existe para segurar);
 *   3. o codec acompanha o contêiner (aac no mp4, Opus no webm — aac em webm é
 *      recusado pelo muxer).
 *
 * Sem ffmpeg na máquina, a suíte pula (como render.test.ts e o ffmpeg do motion).
 */

const desktop = path.resolve(__dirname, '../../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const work = path.join(os.tmpdir(), `orbit-motion-audio-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work, getAppPath: () => desktop, isPackaged: false },
  protocol: {},
  BrowserWindow: class {},
}))

const { runFfmpeg, runFfprobe } = await import('./ffmpeg')
const { motionAudioFfmpegArgs, motionAudioMixFfmpegArgs, motionFfmpegArgs } = await import('./motion-render-args')

const W = 64
const H = 64
const FPS = 5
/** A peça deste teste: 4 quadros a 5 fps = 0,8s. */
const FRAMES = 4
const PIECE = FRAMES / FPS

/** Um quadro opaco, como o caminho sem alfa (janela de fundo preto) entrega. */
function opaqueFrame(r: number, g: number, b: number): Buffer {
  const frame = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    frame[i * 4] = b
    frame[i * 4 + 1] = g
    frame[i * 4 + 2] = r
    frame[i * 4 + 3] = 255
  }
  return frame
}

/** O stdin de uma faixa: os mesmos bytes, quadro após quadro. */
function frames(frame: Buffer, count: number): Readable {
  return Readable.from([Buffer.concat(Array.from({ length: count }, () => frame))])
}

/** Os argumentos de UMA faixa, como o render monta (uma faixa = o vídeo inteiro). */
function bandArgs(format: Parameters<typeof motionFfmpegArgs>[0]['format'], output: string): string[] {
  return motionFfmpegArgs({ width: W, height: H, captureWidth: W, captureHeight: H, fps: FPS, format, output })
}

/**
 * Um tom de 440 Hz em PCM16 mono, montado aqui e entregue cru no stdin do
 * ffmpeg: áudio de verdade sem depender do lavfi (a build que o app leva junto
 * não é obrigada a trazer os filtros de síntese).
 */
async function tone(file: string, seconds: number): Promise<void> {
  const samples = Math.round(44100 * seconds)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((i / 44100) * 2 * Math.PI * 440) * 8000), i * 2)
  }
  await runFfmpeg(['-v', 'error', '-f', 's16le', '-ar', '44100', '-ac', '1', '-i', 'pipe:0', file], {
    stdin: Readable.from([pcm]),
  })
}

async function frameCount(file: string): Promise<number> {
  const { stdout } = await runFfprobe([
    '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ])
  return Number(stdout.toString().trim())
}

async function duration(file: string): Promise<number> {
  const { stdout } = await runFfprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return Number(stdout.toString().trim())
}

async function audioCodec(file: string): Promise<string> {
  const { stdout } = await runFfprobe([
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file,
  ])
  return stdout.toString().trim()
}

/**
 * Pico do áudio num trecho, de 0 a 1, medido no PCM decodificado. É o que prova
 * que a faixa está no INSTANTE declarado — que o arquivo tem som, o ffprobe já diz.
 */
async function peak(file: string, from: number, to: number): Promise<number> {
  const raw = `${file}.${from}-${to}.raw`
  await runFfmpeg(['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '8000', raw])
  const pcm = await fsp.readFile(raw)
  let max = 0
  for (let i = Math.floor(from * 8000); i < Math.min(Math.ceil(to * 8000), pcm.length / 2); i++) {
    max = Math.max(max, Math.abs(pcm.readInt16LE(i * 2)) / 32768)
  }
  return max
}

/** Monta o vídeo mudo da peça (uma faixa, como o caminho sequencial). */
async function muteVideo(file: string, format: Parameters<typeof bandArgs>[0]): Promise<void> {
  await runFfmpeg(bandArgs(format, file), { stdin: frames(opaqueFrame(0, 200, 90), FRAMES) })
}

describe.skipIf(!hasFfmpeg)('áudio da composição (ffmpeg real)', () => {
  beforeAll(async () => {
    await fsp.mkdir(work, { recursive: true })
  })

  afterAll(async () => {
    await fsp.rm(work, { recursive: true, force: true })
  })

  it('áudio mais longo é cortado no fim da peça, sem re-encodar nem perder quadro', async () => {
    const video = path.join(work, 'mute-long.mp4')
    await muteVideo(video, 'mp4')
    const audio = path.join(work, 'tone-2s.wav')
    await tone(audio, 2)
    const out = path.join(work, 'with-long-audio.mp4')

    await runFfmpeg(motionAudioFfmpegArgs({ video, audio, output: out, duration: PIECE, format: 'mp4' }))

    expect(await audioCodec(out)).toBe('aac')
    // O `-t` corta o som, não a imagem: quadro por quadro continua a peça inteira.
    expect(await frameCount(out)).toBe(FRAMES)
    expect(await duration(out)).toBeCloseTo(PIECE, 1)
  })

  it('áudio mais curto deixa a cauda em silêncio, sem encurtar o vídeo', async () => {
    const video = path.join(work, 'mute-short.mp4')
    await muteVideo(video, 'mp4')
    const audio = path.join(work, 'tone-short.wav')
    await tone(audio, 0.15)
    const out = path.join(work, 'with-short-audio.mp4')

    await runFfmpeg(motionAudioFfmpegArgs({ video, audio, output: out, duration: PIECE, format: 'mp4' }))

    expect(await audioCodec(out)).toBe('aac')
    // É AQUI que o `-shortest` quebraria: com ele o vídeo sairia com 1 quadro.
    expect(await frameCount(out)).toBe(FRAMES)
    expect(await duration(out)).toBeCloseTo(PIECE, 1)
  })

  it('webm leva Opus: o contêiner não aceita aac', async () => {
    const video = path.join(work, 'mute.webm')
    await muteVideo(video, 'webm')
    const audio = path.join(work, 'tone-webm.wav')
    await tone(audio, 1)
    const out = path.join(work, 'with-audio.webm')

    await runFfmpeg(motionAudioFfmpegArgs({ video, audio, output: out, duration: PIECE, format: 'webm' }))

    expect(await audioCodec(out)).toBe('opus')
    expect(await frameCount(out)).toBe(FRAMES)
  })

  it('a faixa entra no INSTANTE declarado: antes do start é silêncio', async () => {
    const video = path.join(work, 'mix-late.mp4')
    await muteVideo(video, 'mp4')
    const audio = path.join(work, 'late.wav')
    await tone(audio, 0.3)
    const out = path.join(work, 'with-late.mp4')

    await runFfmpeg(
      motionAudioMixFfmpegArgs({
        video,
        output: out,
        duration: PIECE,
        format: 'mp4',
        events: [{ file: audio, start: 0.4, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false }],
      }),
    )

    // O `adelay` tem que ter empurrado o som de verdade: nada antes de 0,4s, som
    // depois. É o que os argumentos sozinhos não provam — só o ffmpeg.
    expect(await peak(out, 0, 0.3)).toBeLessThan(0.001)
    expect(await peak(out, 0.45, 0.68)).toBeGreaterThan(0.01)
    expect(await duration(out)).toBeCloseTo(PIECE, 1)
  })

  it('cama com duck + narração + efeito: o grafo roda e o comprimento é o da peça', async () => {
    const video = path.join(work, 'mix-bed.mp4')
    await muteVideo(video, 'mp4')
    const voice = path.join(work, 'voice.wav')
    const bed = path.join(work, 'bed.wav')
    const hit = path.join(work, 'hit.wav')
    await tone(voice, PIECE)
    await tone(bed, 2)
    await tone(hit, 0.2)
    const out = path.join(work, 'with-bed.mp4')

    await runFfmpeg(
      motionAudioMixFfmpegArgs({
        video,
        output: out,
        duration: PIECE,
        format: 'mp4',
        events: [
          { file: voice, start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
          { file: bed, start: 0, gainDb: -18, fadeIn: 0.2, fadeOut: 0.3, duck: true },
          { file: hit, start: 0.5, gainDb: -6, fadeIn: 0, fadeOut: 0, duck: false },
        ],
      }),
    )

    // O `sidechaincompress` com os rótulos deste grafo é o pedaço mais frágil:
    // se ele não rodasse, aqui sairia erro e não um arquivo.
    expect(await audioCodec(out)).toBe('aac')
    expect(await frameCount(out)).toBe(FRAMES)
    // A cama tem 2s numa peça de 0,8s: o `-t` a corta, e nada estica o arquivo.
    expect(await duration(out)).toBeCloseTo(PIECE, 1)
    expect(await duration(out)).toBeLessThan(PIECE + 0.2)
  })
})
