import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * O caminho de um vídeo anexado, de ponta a ponta, com o ffmpeg/ffprobe de
 * verdade: guardar → ficha (ffprobe) → miniatura → nota → levar para uma peça.
 * Sem ffmpeg na máquina, a suíte pula (como as outras que dependem dele).
 */

const desktop = path.resolve(__dirname, '../../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const work = path.join(os.tmpdir(), `orbit-attachment-flow-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work, getAppPath: () => desktop, isPackaged: false },
  protocol: {},
  BrowserWindow: class {},
}))

const { runFfmpeg } = await import('./ffmpeg')
const { motionFfmpegArgs, motionAudioFfmpegArgs } = await import('./motion-render-args')
const { saveVideoAttachment, resolveAttachmentRef } = await import('../attachment-ref')
const { probeVideoAttachment, videoAttachmentNote, videoPoster } = await import('./attachment-note')
const { importAttachmentInto } = await import('./motion-asset')

const W = 64
const H = 64
const FPS = 5
const FRAMES = 10 // 2 s

async function makeClip(file: string, withSound: boolean): Promise<void> {
  const frame = Buffer.alloc(W * H * 4, 200)
  const silent = withSound ? path.join(work, `silent-${path.basename(file)}`) : file
  await runFfmpeg(
    motionFfmpegArgs({ width: W, height: H, captureWidth: W, captureHeight: H, fps: FPS, format: 'mp4', output: silent }),
    { stdin: Readable.from([Buffer.concat(Array.from({ length: FRAMES }, () => frame))]) },
  )
  if (!withSound) return
  const rate = 44100
  const pcm = Buffer.alloc(rate * 2 * 2)
  for (let i = 0; i < rate * 2; i++) pcm.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), i * 2)
  const wav = path.join(work, 'tone.wav')
  await runFfmpeg(['-v', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', wav], { stdin: Readable.from([pcm]) })
  await runFfmpeg(motionAudioFfmpegArgs({ video: silent, audio: wav, output: file, duration: FRAMES / FPS, format: 'mp4' }))
}

describe.skipIf(!hasFfmpeg)('vídeo anexado (ffmpeg real)', () => {
  beforeAll(async () => {
    await fsp.mkdir(work, { recursive: true })
  })
  afterAll(async () => {
    await fsp.rm(work, { recursive: true, force: true })
  })

  it('guarda por cópia, sonda, tira a miniatura e escreve a nota curta', async () => {
    const original = path.join(work, 'Entrevista.mp4')
    await makeClip(original, true)
    const saved = await saveVideoAttachment({ copyFrom: original }, 'mp4', { name: 'Entrevista.mp4' })

    const probe = await probeVideoAttachment(saved.file)
    expect(probe?.video).toHaveLength(1)
    expect(probe?.audio).toHaveLength(1)
    expect(probe!.durationMs).toBeGreaterThan(1500)

    const poster = await videoPoster(saved.file, probe!.durationMs)
    expect(poster).toMatch(/^data:image\/webp;base64,/)

    const note = videoAttachmentNote({ filename: 'Entrevista.mp4', id: saved.id, file: saved.file, probe })
    expect(note).toContain(`ref ${saved.id}`)
    expect(note).toContain('64x64 @ 5 fps')
    expect(note).toContain('video_transcribe')
    // O original continua onde estava.
    expect(fs.existsSync(original)).toBe(true)
  })

  it('arquivo que não é vídeo não tem faixa de vídeo para sondar', async () => {
    const fake = path.join(work, 'fake.mp4')
    await fsp.writeFile(fake, 'isto não é um vídeo')
    expect(await probeVideoAttachment(fake)).toBeNull()
  })

  it('motion_asset leva o anexo para a peça e a ficha diz que ele tem som', async () => {
    const original = path.join(work, 'Cena.mp4')
    await makeClip(original, true)
    const saved = await saveVideoAttachment({ copyFrom: original }, 'mp4', { name: 'Cena.mp4' })
    expect((await resolveAttachmentRef(saved.id))?.file).toBe(saved.file)

    const piece = path.join(work, 'piece')
    const imported = await importAttachmentInto(piece, saved.id)
    expect(imported.name).toBe('Cena.mp4')
    expect(fs.existsSync(path.join(piece, 'Cena.mp4'))).toBe(true)
    expect(imported.report).toContain('2.0 s, 64x64 @ 5 fps, audio')
    expect(imported.report).toContain('MIXED into the render')
  })
})
