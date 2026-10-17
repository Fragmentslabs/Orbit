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

  // O tratamento é filtro de ffmpeg escrito à mão: só rodar prova que o grafo é
  // válido (nome de opção, aspas da expressão, rótulos) E que faz o que diz.
  describe('tratamento', () => {
    const plainEvent = { start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false }
    const noFx = { eq: [], automation: [] }

    it('passa-alta, eq, compressor e curva de volume: o grafo roda e a curva SOBE o nível', async () => {
      const video = path.join(work, 'fx-video.mp4')
      await muteVideo(video, 'mp4')
      const voice = path.join(work, 'fx-voice.wav')
      await tone(voice, PIECE)
      const out = path.join(work, 'fx.mp4')

      await runFfmpeg(
        motionAudioMixFfmpegArgs({
          video,
          output: out,
          duration: PIECE,
          format: 'mp4',
          events: [
            {
              ...plainEvent,
              file: voice,
              fx: {
                ...noFx,
                highpass: 80,
                eq: [{ freq: 440, gain: 3, q: 1 }],
                compress: { threshold: -24, ratio: 3, attack: 5, release: 100, makeup: 0 },
                // Começa 30 dB abaixo e chega a 0 dB no fim da peça.
                automation: [
                  { at: 0, db: -30 },
                  { at: PIECE, db: 0 },
                ],
              },
            },
          ],
        }),
      )

      expect(await audioCodec(out)).toBe('aac')
      expect(await frameCount(out)).toBe(FRAMES)
      // A curva é por TEMPO DA PEÇA: o começo sai bem mais baixo que o fim.
      expect(await peak(out, 0.05, 0.2)).toBeLessThan(await peak(out, 0.6, 0.78))
    })

    it('a curva também vale para uma faixa que entra tarde (o t é o da peça, depois do atraso)', async () => {
      const video = path.join(work, 'fx-late-video.mp4')
      await muteVideo(video, 'mp4')
      const hit = path.join(work, 'fx-late.wav')
      await tone(hit, 0.4)
      const out = path.join(work, 'fx-late.mp4')

      await runFfmpeg(
        motionAudioMixFfmpegArgs({
          video,
          output: out,
          duration: PIECE,
          format: 'mp4',
          // Entra em 0,4s; a curva diz "mudo até 0,5s". Se o t fosse o da faixa
          // (e não o da peça), o trecho 0,4–0,5 ainda seria mudo por mais 0,5s.
          events: [
            {
              ...plainEvent,
              start: 0.4,
              file: hit,
              fx: {
                ...noFx,
                automation: [
                  { at: 0.5, db: -60 },
                  { at: 0.52, db: 0 },
                ],
              },
            },
          ],
        }),
      )

      expect(await peak(out, 0.41, 0.49)).toBeLessThan(0.001)
      expect(await peak(out, 0.6, 0.78)).toBeGreaterThan(0.01)
    })

    it('o teto de pico de verdade segura o som, e o volume de entrega roda no mesmo grafo', async () => {
      const video = path.join(work, 'master-video.mp4')
      await muteVideo(video, 'mp4')
      const loud = path.join(work, 'master-loud.wav')
      await tone(loud, PIECE)
      const raw = path.join(work, 'master-raw.mp4')
      const limited = path.join(work, 'master-limited.mp4')
      const normalized = path.join(work, 'master-normalized.mp4')
      const base = { video, duration: PIECE, format: 'mp4' as const }
      // +12 dB sobre um tom já forte: passa de 1.0 sem teto.
      const events = [{ ...plainEvent, file: loud, gainDb: 12 }]

      await runFfmpeg(motionAudioMixFfmpegArgs({ ...base, output: raw, events }))
      await runFfmpeg(motionAudioMixFfmpegArgs({ ...base, output: limited, events, master: { limit: -6 } }))
      await runFfmpeg(motionAudioMixFfmpegArgs({ ...base, output: normalized, events, master: { loudness: -16, limit: -1 } }))

      const ceiling = Math.pow(10, -6 / 20)
      expect(await peak(limited, 0.1, 0.7)).toBeLessThanOrEqual(ceiling + 0.03)
      expect(await peak(limited, 0.1, 0.7)).toBeLessThan(await peak(raw, 0.1, 0.7))
      // O loudnorm devolve 192 kHz; sem o aresample o aac sairia em taxa absurda.
      const { stdout } = await runFfprobe(['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', normalized])
      expect(Number(stdout.toString().trim())).toBe(48000)
      expect(await frameCount(normalized)).toBe(FRAMES)
    })

    it('o duck personalizado roda com os rótulos do grafo', async () => {
      const video = path.join(work, 'duck-video.mp4')
      await muteVideo(video, 'mp4')
      const voice = path.join(work, 'duck-voice.wav')
      const bed = path.join(work, 'duck-bed.wav')
      await tone(voice, 0.3)
      await tone(bed, PIECE)
      const out = path.join(work, 'duck.mp4')

      await runFfmpeg(
        motionAudioMixFfmpegArgs({
          video,
          output: out,
          duration: PIECE,
          format: 'mp4',
          events: [
            { ...plainEvent, file: voice },
            { ...plainEvent, file: bed, duck: true, duckSettings: { threshold: 0.01, ratio: 8, attack: 10, release: 100 } },
          ],
        }),
      )
      expect(await frameCount(out)).toBe(FRAMES)
    })
  })
})
