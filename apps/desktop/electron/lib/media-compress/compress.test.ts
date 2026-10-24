import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Compressão de ponta a ponta com o ffmpeg de verdade (o que vem com o app).
 * Sem o binário na máquina, a suíte pula — o planejamento continua coberto pelo
 * plan.test.ts, que é puro.
 */

const desktop = path.resolve(__dirname, '../../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const work = path.join(os.tmpdir(), `orbit-media-compress-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work, getAppPath: () => desktop, isPackaged: false },
  protocol: {},
  BrowserWindow: class {},
}))

const { runFfmpeg, probeMedia } = await import('../video/ffmpeg')
const { compressMedia, buildFfmpegArgs } = await import('./compress')
const { buildPlan } = await import('./plan')

const source = path.join(work, 'source.mp4')

beforeAll(async () => {
  await fsp.mkdir(work, { recursive: true })
  // 6 s, 640x360, com áudio e bitrate alto de propósito: dá margem para
  // comprimir de verdade e medir o antes/depois.
  await runFfmpeg([
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-shortest',
    '-c:v', 'libx264', '-b:v', '1200k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    source,
  ])
}, 120_000)

afterAll(async () => {
  await fsp.rm(work, { recursive: true, force: true })
})

describe('buildFfmpegArgs', () => {
  const plan = buildPlan({
    probe: {
      file: source,
      durationMs: 6000,
      sizeBytes: 900_000,
      format: 'mp4',
      video: [{ index: 0, codec: 'h264', width: 1280, height: 720, fps: 30, rotation: 0, pixFmt: 'yuv420p' }],
      audio: [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2 }],
      display: { width: 1280, height: 720 },
    },
    target: { maxBytes: 200_000 },
    container: 'mp4',
  })

  it('teto em bytes codifica com maxrate e sem CRF', () => {
    const args = buildFfmpegArgs('in.mp4', 'out.mp4', plan)
    expect(args).toContain('-maxrate')
    expect(args).toContain('-bufsize')
    expect(args).not.toContain('-crf')
    expect(args.join(' ')).toContain('-movflags +faststart')
  })

  it('mapeia os streams explicitamente e descarta legenda/dados', () => {
    const args = buildFfmpegArgs('in.mp4', 'out.mp4', plan)
    expect(args.slice(0, 8)).toEqual(['-v', 'error', '-i', 'in.mp4', '-map', '0:v:0', '-map', '0:a:0?'])
    expect(args).toContain('-sn')
    expect(args).toContain('-dn')
  })

  it('stripAudio remove a faixa de verdade', () => {
    const muted = buildPlan({
      probe: {
        file: source,
        durationMs: 6000,
        sizeBytes: 900_000,
        format: 'mp4',
        video: [{ index: 0, codec: 'h264', width: 1280, height: 720, fps: 30, rotation: 0 }],
        audio: [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2 }],
        display: { width: 1280, height: 720 },
      },
      target: { quality: 70 },
      stripAudio: true,
    })
    const args = buildFfmpegArgs('in.mp4', 'out.mp4', muted)
    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
  })
})

describe.skipIf(!hasFfmpeg)('compressMedia (real ffmpeg)', () => {
  it('cabe no teto em bytes e mantém a duração', async () => {
    const out = path.join(work, 'out', 'small.mp4')
    const report = await compressMedia({ file: source, output: out, target: { maxBytes: 200_000 } })

    expect(report.skipped).toBe(false)
    expect(report.kind).toBe('video')
    expect(report.withinTarget).toBe(true)
    expect(report.after.sizeBytes).toBeLessThanOrEqual(200_000)
    expect(report.after.sizeBytes).toBeLessThan(report.before.sizeBytes)
    expect(report.attempts).toBeGreaterThanOrEqual(1)
    expect(Math.abs(report.after.durationMs - report.before.durationMs)).toBeLessThan(200)
    expect(report.after.video).toHaveLength(1)
    expect(report.after.audio).toHaveLength(1)
    expect(fs.existsSync(out)).toBe(true)
    // Nada de temporário largado ao lado do arquivo final.
    expect((await fsp.readdir(path.dirname(out))).filter((f) => f.includes('.part'))).toHaveLength(0)
  }, 120_000)

  it('não recodifica o que já cabe no alvo', async () => {
    const stat = await fsp.stat(source)
    const out = path.join(work, 'out', 'unnecessary.mp4')
    const report = await compressMedia({ file: source, output: out, target: { maxBytes: stat.size * 2 } })
    expect(report.skipped).toBe(true)
    expect(report.attempts).toBe(0)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('extrai o áudio de um vídeo para mp3', async () => {
    const out = path.join(work, 'out', 'audio.mp3')
    const report = await compressMedia({ file: source, output: out, target: { quality: 70 }, format: 'mp3' })
    expect(report.kind).toBe('audio')
    expect(report.after.video).toHaveLength(0)
    expect(report.after.audio).toHaveLength(1)
    expect(report.after.audio[0].codec).toBe('mp3')
    expect(report.after.sizeBytes).toBeLessThan(report.before.sizeBytes)
  }, 120_000)

  it('reduz resolução sem inflar o fps', async () => {
    const out = path.join(work, 'out', 'smaller.mp4')
    const report = await compressMedia({ file: source, output: out, target: { quality: 70, height: 180 } })
    expect(report.after.display?.height).toBe(180)
    expect(report.after.display?.width).toBe(320)
  }, 120_000)

  it('recusa escrever por cima da origem', async () => {
    await expect(compressMedia({ file: source, output: source, target: { quality: 50 } })).rejects.toThrow(
      /cannot be the source/,
    )
  })

  it('o arquivo comprimido continua legível pelo ffprobe', async () => {
    const out = path.join(work, 'out', 'small.mp4')
    const probe = await probeMedia(out)
    expect(probe.durationMs).toBeGreaterThan(5000)
    expect(probe.video[0].width).toBeGreaterThan(0)
  })
})
