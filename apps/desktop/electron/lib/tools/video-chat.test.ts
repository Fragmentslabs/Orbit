import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Edição de vídeo no MODO CHAT, sem pasta: o vídeo anexado é a fonte do corte (pela
 * referência), a saída mora no armazenamento do app e entra na galeria, de onde
 * se exclui. Ffmpeg de verdade; sem ele na máquina, a suíte pula.
 */

const desktop = path.resolve(__dirname, '../../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const userData = path.join(os.tmpdir(), `orbit-video-chat-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => desktop, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const { runFfmpeg } = await import('../video/ffmpeg')
const { saveVideoAttachment } = await import('../attachment-ref')
const { addVideoToGallery } = await import('../video/video-gallery')
const media = await import('../media')
const { createChatMotionTools, chatMotionDir } = await import('./motion-chat')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: Exec }).execute(input, { toolCallId: 'call1', messages: [], abortSignal: undefined })

const exists = (target: string) =>
  fsp.stat(target).then(
    () => true,
    () => false,
  )

describe.skipIf(!hasFfmpeg)('vídeo no modo chat (ffmpeg real)', () => {
  let refA = ''
  let refB = ''

  beforeAll(async () => {
    await fsp.mkdir(userData, { recursive: true })
    const a = path.join(userData, 'entrevista.mp4')
    const b = path.join(userData, 'bruto.mov')
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a])
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'smptebars=size=320x240:rate=25:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', b])
    refA = (await saveVideoAttachment({ copyFrom: a }, 'mp4', { name: 'entrevista.mp4', sessionId: 'chat1' })).id
    refB = (await saveVideoAttachment({ copyFrom: b }, 'mov', { name: 'bruto.mov', sessionId: 'chat1' })).id
  }, 60_000)

  afterAll(async () => {
    await fsp.rm(userData, { recursive: true, force: true })
  })

  it('o chat ganha video_render e as tools de leitura, que aceitam a referência do anexo', () => {
    const tools = createChatMotionTools({ sessionId: 'chat1', canRender: true })
    for (const name of ['video_render', 'video_probe', 'video_transcribe', 'video_timeline', 'motion_asset', 'motion_render']) {
      expect(tools[name], name).toBeDefined()
    }
    // Sem render (sem ffmpeg ou modo plano) não há como produzir vídeo.
    expect(createChatMotionTools({ sessionId: 'chat1', canRender: false }).video_render).toBeUndefined()
  })

  it('video_probe lê um anexo pela referência, sem pasta de trabalho', async () => {
    const tools = createChatMotionTools({ sessionId: 'chat1', canRender: true })
    const out = String(await run(tools, 'video_probe', { paths: [refA] }))
    expect(out).toContain(refA)
    expect(out).toContain('640x360')
    expect(out).toContain('audio')
    expect(String(await run(tools, 'video_probe', { paths: ['vdo_naoexiste.mp4'] }))).toMatch(/attachment not found/)
  })

  it('corta e junta dois anexos: a saída vai para o app, entra na galeria e some ao excluir', async () => {
    const tools = createChatMotionTools({ sessionId: 'chat1', canRender: true })
    const result = (await run(tools, 'video_render', {
      edl: {
        sources: { A: refA, B: refB },
        ranges: [
          { source: 'A', start: 0, end: 1 },
          { source: 'B', start: 0, end: 1 },
        ],
        snap: false,
      },
    })) as { message: string; videoUrl?: string; path?: string; title?: string }

    expect(result.message).toMatch(/Rendered/)
    expect(result.videoUrl).toMatch(/^orbit-video:\/\//)
    // A saída fica na pasta desta conversa, e não ao lado do anexo.
    const rendersDir = path.join(chatMotionDir('chat1'), 'renders')
    expect(path.dirname(result.path!)).toBe(rendersDir)
    expect(await exists(result.path!)).toBe(true)
    expect(await exists(path.join(path.dirname(await mediaPath(refA)), 'edit', path.basename(result.path!)))).toBe(false)

    const items = (await media.listMedia({ kind: 'video' })).filter((e) => e.path === result.path)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ source: 'chat', sessionId: 'chat1' })
    expect(items[0].durationMs).toBeGreaterThan(1500)

    // Excluir na galeria apaga o arquivo do disco.
    expect(await media.deleteMedia(items[0].id)).toBe(true)
    expect(await exists(result.path!)).toBe(false)
    // …e o anexo de origem continua intacto.
    expect(await exists(await mediaPath(refA))).toBe(true)
  }, 60_000)

  it('cada vídeo final é um item (nome próprio); a prévia é uma só e fica fora da galeria', async () => {
    const tools = createChatMotionTools({ sessionId: 'chat2', canRender: true })
    const edl = { sources: { A: refA }, ranges: [{ source: 'A', start: 0, end: 1 }], snap: false }
    const first = (await run(tools, 'video_render', { edl })) as { path: string }
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = (await run(tools, 'video_render', { edl })) as { path: string }
    expect(second.path).not.toBe(first.path)

    const previewA = (await run(tools, 'video_render', { edl, preview: true })) as { path: string }
    const previewB = (await run(tools, 'video_render', { edl, preview: true })) as { path: string }
    expect(previewA.path).toBe(previewB.path)
    expect(path.basename(previewA.path)).toBe('preview.mp4')

    const paths = (await media.listMedia({ kind: 'video' })).map((e) => e.path)
    expect(paths).toContain(first.path)
    expect(paths).toContain(second.path)
    expect(paths).not.toContain(previewA.path)
  }, 120_000)

  it('refazer o MESMO arquivo de render não cria um cartão novo na galeria', async () => {
    const file = path.join(chatMotionDir('chat3'), 'renders', 'peca.mp4')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.copyFile(await mediaPath(refA), file)
    const first = await addVideoToGallery({ file, name: 'peca.mp4', sessionId: 'chat3', source: 'chat' })
    const again = await addVideoToGallery({ file, name: 'peca.mp4', sessionId: 'chat3', source: 'chat' })
    expect(again.entry.id).toBe(first.entry.id)
    expect((await media.listMedia({ kind: 'video' })).filter((e) => e.path === file)).toHaveLength(1)
  })
})

async function mediaPath(ref: string): Promise<string> {
  const { resolveAttachmentRef } = await import('../attachment-ref')
  const resolved = await resolveAttachmentRef(ref)
  if (!resolved) throw new Error(`no attachment ${ref}`)
  return resolved.file
}
