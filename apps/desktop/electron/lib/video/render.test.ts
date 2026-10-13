import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Render de ponta a ponta com o ffmpeg de verdade (o que `npm run ffmpeg:fetch`
 * baixa). Sem ele na máquina, a suíte pula — o resto dos testes de vídeo é puro.
 */

const desktop = path.resolve(__dirname, '../../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const work = path.join(os.tmpdir(), `orbit-video-render-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work, getAppPath: () => desktop, isPackaged: false },
  protocol: {},
  BrowserWindow: class {},
}))

const { runFfmpeg, probeMedia } = await import('./ffmpeg')
const { renderEdl, parseEbur128 } = await import('./render')

describe('parseEbur128', () => {
  it('reads integrated loudness, true peak and LRA from the summary', () => {
    const stderr = `[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.6 LUFS

  Loudness range:
    LRA:         3.1 LU
    Threshold: -34.5 LUFS
    LRA low:   -16.0 LUFS
    LRA high:  -12.9 LUFS

  True peak:
    Peak:       -1.3 dBFS`
    expect(parseEbur128(stderr)).toEqual({ integratedLufs: -14.2, truePeakDb: -1.3, lra: 3.1 })
  })
})

describe.skipIf(!hasFfmpeg)('renderEdl (real ffmpeg)', () => {
  const a = path.join(work, 'footage', 'a.mp4')
  const b = path.join(work, 'footage', 'b.mov')
  const logo = path.join(work, 'logo.png')

  beforeAll(async () => {
    await fsp.mkdir(path.dirname(a), { recursive: true })
    // A: 1280x720 30 fps com tom; B: 640x480 25 fps SEM áudio (testa o silêncio gerado).
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a])
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'smptebars=size=640x480:rate=25:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', b])
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.6:size=200x80,format=rgba', '-frames:v', '1', logo])
    // Transcrição em cache para A: as legendas e o encaixe saem dela.
    const stat = await fsp.stat(a)
    await fsp.mkdir(path.join(work, 'footage', 'edit', 'transcripts'), { recursive: true })
    await fsp.writeFile(
      path.join(work, 'footage', 'edit', 'transcripts', 'a.mp4.json'),
      JSON.stringify({
        version: 1,
        file: a,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        engine: 'test',
        durationMs: 4000,
        words: [
          { text: 'one', startMs: 400, endMs: 800 },
          { text: 'two', startMs: 900, endMs: 1300 },
          { text: 'three.', startMs: 2000, endMs: 2600 },
        ],
      }),
    )
  }, 60_000)

  afterAll(async () => {
    await fsp.rm(work, { recursive: true, force: true })
  })

  it('cuts, conforms, overlays, burns subtitles, normalizes and measures', async () => {
    const result = await renderEdl(
      {
        sources: { A: a, B: b },
        ranges: [
          { source: 'A', start: 0.5, end: 1.5 },
          { source: 'B', start: 1, end: 2.5 },
          { source: 'A', start: 2.1, end: 3.0, grade: 'warm_cinematic' },
        ],
        grade: 'neutral_punch',
        overlays: [{ file: logo, start: 0.2, duration: 1, x: 'W-w-20', y: 20 }],
        subtitles: { style: 'bold-overlay' },
      },
      { editDir: path.join(work, 'footage', 'edit'), outName: 'final.mp4', preview: false },
    )

    // A1 encaixou nas palavras (0.5 dentro de "one" → 0.4; 1.5 já fora, + folga até 1.58).
    expect(result.snapNotes.some((n) => n.range === 0 && n.edge === 'start')).toBe(true)
    expect(result.ranges[0].startMs).toBe(320)
    expect(result.cutsMs).toHaveLength(2)
    expect(result.width).toBe(1280)
    expect(result.height).toBe(720)
    expect(result.subtitlesFile && fs.existsSync(result.subtitlesFile)).toBe(true)
    expect(result.loudness?.integratedLufs).not.toBeNull()

    const probe = await probeMedia(result.output)
    expect(probe.video[0].width).toBe(1280)
    expect(probe.video[0].fps).toBe(30)
    expect(probe.audio).toHaveLength(1)
    expect(Math.abs(probe.durationMs - result.durationMs)).toBeLessThan(120)
    // A pasta de trabalho temporária some.
    const left = await fsp.readdir(path.join(work, 'footage', 'edit'))
    expect(left.some((f) => f.startsWith('.render-'))).toBe(false)
  }, 120_000)

  it('renders a 720p preview straight from the joined cut when nothing else applies', async () => {
    const result = await renderEdl(
      { sources: { A: a }, ranges: [{ source: 'A', start: 0, end: 2 }], loudness: false, snap: false },
      { editDir: path.join(work, 'footage', 'edit'), outName: 'preview.mp4', preview: true },
    )
    expect(result.height).toBe(720)
    expect(result.cutsMs).toEqual([])
    expect(fs.existsSync(result.output)).toBe(true)
  }, 60_000)
})
