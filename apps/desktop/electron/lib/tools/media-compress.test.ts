import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A camada da tool: onde o arquivo nasce, como o resultado é relatado e o que
 * ela recusa. O encode em si é o do compress.test.ts.
 */

const desktop = path.resolve(__dirname, '../../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const work = path.join(os.tmpdir(), `orbit-media-tool-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work, getAppPath: () => desktop, isPackaged: false },
  protocol: {},
  BrowserWindow: class {},
}))

const { runFfmpeg } = await import('../video/ffmpeg')
const { createMediaTools } = await import('./media-compress')

const source = path.join(work, 'clip.mp4')

beforeAll(async () => {
  await fsp.mkdir(work, { recursive: true })
  await runFfmpeg([
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
    '-shortest', '-c:v', 'libx264', '-b:v', '900k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    source,
  ])
}, 120_000)

afterAll(async () => {
  await fsp.rm(work, { recursive: true, force: true })
})

function context(canShow: boolean) {
  const tools = createMediaTools({ sessionId: 'sess1', canShow }, {
    sessionId: 'sess1',
    directory: work,
    extraDirectories: [],
    abort: new AbortController().signal,
  })
  // O execute do AI SDK recebe um ToolCallOptions inteiro; no teste só o signal importa.
  const execute = tools.media_compress.execute as unknown as (
    input: Record<string, unknown>,
    options: { abortSignal: AbortSignal },
  ) => Promise<string | Record<string, unknown>>
  return (input: Record<string, unknown>) => execute(input, { abortSignal: new AbortController().signal })
}

describe.skipIf(!hasFfmpeg)('media_compress (tool)', () => {
  it('grava em media/ ao lado da origem e relata os números', async () => {
    const run = context(false)
    const out = await run({ ref: 'clip.mp4', maxBytes: 120_000 })
    expect(typeof out).toBe('string')
    expect(out as string).toMatch(/Compressed clip\.mp4: .*→/)
    expect(out as string).toMatch(/File: media\/clip-compressed\.mp4/)

    const file = path.join(work, 'media', 'clip-compressed.mp4')
    expect(fs.existsSync(file)).toBe(true)
    expect((await fsp.stat(file)).size).toBeLessThanOrEqual(120_000)
    // A origem continua intacta.
    expect((await fsp.stat(source)).size).toBeGreaterThan(120_000)
  }, 120_000)

  it('respeita outputPath quando o usuário pede onde salvar', async () => {
    const run = context(false)
    await run({ ref: 'clip.mp4', quality: 60, outputPath: 'saida/pequeno.mp4' })
    expect(fs.existsSync(path.join(work, 'saida', 'pequeno.mp4'))).toBe(true)
  }, 120_000)

  it('com canShow devolve o player do vídeo', async () => {
    const run = context(true)
    const out = await run({ ref: 'clip.mp4', quality: 60 })
    expect(typeof out).toBe('object')
    expect(String((out as Record<string, unknown>).videoUrl)).toMatch(/^orbit-video:\/\//)
    expect(String((out as Record<string, unknown>).message)).toContain('Compressed')
  }, 120_000)

  it('extrair áudio num contêiner de áudio muda o tipo do resultado', async () => {
    const run = context(false)
    const out = await run({ ref: 'clip.mp4', format: 'mp3', quality: 70 })
    expect(out as string).toContain('Output: audio mp3')
    expect(fs.existsSync(path.join(work, 'media', 'clip-compressed.mp3'))).toBe(true)
  }, 120_000)

  it('recusa imagem e aponta o image_edit', async () => {
    const run = context(false)
    await expect(run({ ref: 'img_abc123.png', maxBytes: 1000 })).rejects.toThrow(/image_edit/)
  })

  it('recusa extensão que não é mídia', async () => {
    const run = context(false)
    await expect(run({ ref: 'notes.txt', maxBytes: 1000 })).rejects.toThrow(/audio or video/)
  })
})
