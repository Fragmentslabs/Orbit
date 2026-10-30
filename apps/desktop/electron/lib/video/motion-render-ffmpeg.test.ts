import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The PIXEL path of motion end to end, with the real ffmpeg: the
 * raw BGRA frame enters through stdin, the alpha is unpremultiplied before the format
 * conversion and the video comes out with straight color. It is what can be checked outside
 * Electron — the window capture, it cannot. Without ffmpeg on the machine, the suite skips (like
 * render.test.ts).
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

/** Straight color (200,100,50) at 50% alpha, as Chromium's `toBitmap()` delivers it: premultiplied. */
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

/** An opaque frame, as the path without alpha (black-background window) delivers. */
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

/** The stdin of one track: the same bytes, frame after frame. */
function frames(frame: Buffer, count: number): Readable {
  return Readable.from([Buffer.concat(Array.from({ length: count }, () => frame))])
}

/** The arguments of ONE track, as the render builds them (one track = the whole video). */
function bandArgs(format: Parameters<typeof motionFfmpegArgs>[0]['format'], output: string): string[] {
  return motionFfmpegArgs({ width: W, height: H, captureWidth: W, captureHeight: H, fps: FPS, format, output })
}

/** First pixel of the video in RGBA. `decoder` forces the decoder (see VP9 with alpha). */
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

describe.skipIf(!hasFfmpeg)('motion pixel path (real ffmpeg)', () => {
  beforeAll(async () => {
    await fsp.mkdir(work, { recursive: true })
  })

  afterAll(async () => {
    await fsp.rm(work, { recursive: true, force: true })
  })

  it('mov-alpha: the raw un-premultiplied frame comes out with straight color in ProRes 4444', async () => {
    const frame = premultipliedFrame()
    unpremultiplyBgra(frame)
    const out = path.join(work, 'alpha.mov')
    await runFfmpeg(bandArgs('mov-alpha', out), { stdin: frames(frame, 3) })

    expect(await frameCount(out)).toBe(3)
    const px = await firstPixel(out)
    // Straight color (200,100,50) with alpha 128 — and not (100,50,25), which is what would come out
    // without the unpremultiplication: it is that difference that this test exists to catch.
    expectPixel(px, [200, 100, 50, 128], 3)
    expect(Math.abs(px[0] - 100)).toBeGreaterThan(50)
  })

  it('webm-alpha: VP9 with alpha also comes out with straight color', async () => {
    const frame = premultipliedFrame()
    unpremultiplyBgra(frame)
    const out = path.join(work, 'alpha.webm')
    await runFfmpeg(bandArgs('webm-alpha', out), { stdin: frames(frame, 3) })

    expect(await frameCount(out)).toBe(3)
    // The VP9 alpha IS in the file (the muxer marks alpha_mode=1), but the
    // NATIVE decoder of ffmpeg does not expose it — it comes out as opaque yuv420p. Whoever
    // sees it is libvpx-vp9, which is how players and editors read the file.
    // VP9 is lossy and the alpha goes in yuva420p (subsampled chroma): the tolerance
    // is larger, but still much smaller than the distance to the premultiplied color.
    const px = await firstPixel(out, 'libvpx-vp9')
    expectPixel(px, [200, 100, 50, 128], 16)
    expect(Math.abs(px[0] - 100)).toBeGreaterThan(50)
  })

  it('mp4: the path with no alpha comes out at the requested size, frame by frame', async () => {
    const out = path.join(work, 'opaque.mp4')
    await runFfmpeg(bandArgs('mp4', out), { stdin: frames(opaqueFrame(255, 0, 0), 4) })

    expect(await frameCount(out)).toBe(4)
    expectPixel(await firstPixel(out), [255, 0, 0, 255], 2)
    const { stdout } = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out])
    expect(stdout.toString().trim()).toBe(`${W},${H}`)
  })

  it('the bands concatenate without losing or duplicating a frame', async () => {
    const dir = path.join(work, 'bands')
    await fsp.mkdir(dir, { recursive: true })
    const frame = opaqueFrame(0, 0, 255)
    for (const name of ['band_000.mp4', 'band_001.mp4']) {
      await runFfmpeg(bandArgs('mp4', name), { stdin: frames(frame, 2), cwd: dir })
    }
    await fsp.writeFile(path.join(dir, 'list.txt'), concatList(['band_000.mp4', 'band_001.mp4']))
    const out = path.join(dir, 'joined.mp4')
    await runFfmpeg(concatFfmpegArgs({ listFile: 'list.txt', output: out, format: 'mp4' }), { cwd: dir })

    // 2 + 2 frames: the concatenation is what joins the tracks into a single video.
    expect(await frameCount(out)).toBe(4)
  })
})
