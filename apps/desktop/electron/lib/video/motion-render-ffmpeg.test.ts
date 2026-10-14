import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * O caminho de PIXELS do motion de ponta a ponta, com o ffmpeg de verdade: o
 * quadro BGRA cru entra pelo stdin, o alfa é desmultiplicado antes da conversão
 * de formato e o vídeo sai com a cor reta. É o que se pode conferir fora do
 * Electron — a captura da janela, não. Sem ffmpeg na máquina, a suíte pula (como
 * o render.test.ts).
 */

const desktop = path.resolve(__dirname, '../../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const work = path.join(os.tmpdir(), `orbit-motion-raw-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work, getAppPath: () => desktop, isPackaged: false },
  protocol: {},
  BrowserWindow: class {},
}))

const { runFfmpeg, runFfprobe } = await import('./ffmpeg')
const { concatFfmpegArgs, concatList, motionFfmpegArgs, unpremultiplyBgra } = await import('./motion-render-args')

const W = 64
const H = 64
const FPS = 5

/** Cor reta (200,100,50) a 50% de alfa, como o `toBitmap()` do Chromium entrega: pré-multiplicada. */
function premultipliedFrame(): Buffer {
  const frame = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    frame[i * 4] = 25
    frame[i * 4 + 1] = 50
    frame[i * 4 + 2] = 100
    frame[i * 4 + 3] = 128
  }
  return frame
}

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

/** Primeiro pixel do vídeo em RGBA. `decoder` força o decodificador (ver o VP9 com alfa). */
async function firstPixel(file: string, decoder?: string): Promise<number[]> {
  const { stdout } = await runFfmpeg([
    '-v', 'error', ...(decoder ? ['-c:v', decoder] : []), '-i', file,
    '-vf', 'format=rgba', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
  ])
  return [stdout[0], stdout[1], stdout[2], stdout[3]]
}

async function frameCount(file: string): Promise<number> {
  const { stdout } = await runFfprobe([
    '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ])
  return Number(stdout.toString().trim())
}

function expectPixel(actual: number[], [r, g, b, a]: number[], tolerance: number): void {
  for (const [i, expected] of [r, g, b, a].entries()) {
    expect(Math.abs(actual[i] - expected), `canal ${i}: ${actual[i]} != ${expected}`).toBeLessThanOrEqual(tolerance)
  }
}

describe.skipIf(!hasFfmpeg)('caminho de pixels do motion (ffmpeg real)', () => {
  beforeAll(async () => {
    await fsp.mkdir(work, { recursive: true })
  })

  afterAll(async () => {
    await fsp.rm(work, { recursive: true, force: true })
  })

  it('mov-alpha: o quadro cru desmultiplicado sai com a cor reta no ProRes 4444', async () => {
    const frame = premultipliedFrame()
    unpremultiplyBgra(frame)
    const out = path.join(work, 'alpha.mov')
    await runFfmpeg(bandArgs('mov-alpha', out), { stdin: frames(frame, 3) })

    expect(await frameCount(out)).toBe(3)
    const px = await firstPixel(out)
    // Cor reta (200,100,50) com alfa 128 — e não (100,50,25), que é o que sairia
    // sem a desmultiplicação: é essa diferença que este teste existe para pegar.
    expectPixel(px, [200, 100, 50, 128], 3)
    expect(Math.abs(px[0] - 100)).toBeGreaterThan(50)
  })

  it('webm-alpha: VP9 com alfa também sai com a cor reta', async () => {
    const frame = premultipliedFrame()
    unpremultiplyBgra(frame)
    const out = path.join(work, 'alpha.webm')
    await runFfmpeg(bandArgs('webm-alpha', out), { stdin: frames(frame, 3) })

    expect(await frameCount(out)).toBe(3)
    // O alfa do VP9 ESTÁ no arquivo (o muxer marca alpha_mode=1), mas o
    // decodificador NATIVO do ffmpeg não o expõe — sai yuv420p opaco. Quem o
    // enxerga é o libvpx-vp9, que é como players e editoras leem o arquivo.
    // VP9 é com perda e o alfa vai em yuva420p (croma subamostrado): a tolerância
    // é maior, mas ainda muito menor que a distância até a cor pré-multiplicada.
    const px = await firstPixel(out, 'libvpx-vp9')
    expectPixel(px, [200, 100, 50, 128], 16)
    expect(Math.abs(px[0] - 100)).toBeGreaterThan(50)
  })

  it('mp4: o caminho sem alfa sai no tamanho pedido, quadro a quadro', async () => {
    const out = path.join(work, 'opaque.mp4')
    await runFfmpeg(bandArgs('mp4', out), { stdin: frames(opaqueFrame(255, 0, 0), 4) })

    expect(await frameCount(out)).toBe(4)
    expectPixel(await firstPixel(out), [255, 0, 0, 255], 2)
    const { stdout } = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out])
    expect(stdout.toString().trim()).toBe(`${W},${H}`)
  })

  it('as faixas concatenam sem perder nem duplicar quadro', async () => {
    const dir = path.join(work, 'bands')
    await fsp.mkdir(dir, { recursive: true })
    const frame = opaqueFrame(0, 0, 255)
    for (const name of ['band_000.mp4', 'band_001.mp4']) {
      await runFfmpeg(bandArgs('mp4', name), { stdin: frames(frame, 2), cwd: dir })
    }
    await fsp.writeFile(path.join(dir, 'list.txt'), concatList(['band_000.mp4', 'band_001.mp4']))
    const out = path.join(dir, 'joined.mp4')
    await runFfmpeg(concatFfmpegArgs({ listFile: 'list.txt', output: out, format: 'mp4' }), { cwd: dir })

    // 2 + 2 quadros: a concatenação é o que junta as faixas em um vídeo só.
    expect(await frameCount(out)).toBe(4)
  })
})
