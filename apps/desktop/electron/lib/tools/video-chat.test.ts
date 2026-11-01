import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Video editing in CHAT MODE, without a folder: the attached video is the cut source (by
 * reference), the output lives in the app's storage and enters the gallery, from where
 * it is deleted. Real ffmpeg; without it on the machine, the suite skips.
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
const { createMotionTools, motionPiecesDir } = await import('./motion')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: Exec }).execute(input, { toolCallId: 'call1', messages: [], abortSignal: undefined })

const exists = (target: string) =>
  fsp.stat(target).then(
    () => true,
    () => false,
  )

describe.skipIf(!hasFfmpeg)('video in chat mode (real ffmpeg)', () => {
  let refA = ''
  let refB = ''

  beforeAll(async () => {
    await fsp.mkdir(userData, { recursive: true })
    const a = path.join(userData, 'interview.mp4')
    const b = path.join(userData, 'raw.mov')
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a])
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'smptebars=size=320x240:rate=25:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', b])
    refA = (await saveVideoAttachment({ copyFrom: a }, 'mp4', { name: 'interview.mp4', sessionId: 'chat1' })).id
    refB = (await saveVideoAttachment({ copyFrom: b }, 'mov', { name: 'raw.mov', sessionId: 'chat1' })).id
  }, 60_000)

  afterAll(async () => {
    await fsp.rm(userData, { recursive: true, force: true })
  })

  it('the chat gets video_render and the reading tools, which accept the attachment ref', () => {
    const tools = createMotionTools({ sessionId: 'chat1', canRender: true })
    for (const name of ['video_render', 'video_probe', 'transcribe', 'video_timeline', 'motion_asset', 'motion_render']) {
      expect(tools[name], name).toBeDefined()
    }
    // With no render (no ffmpeg or plan mode) there is no way to produce video.
    expect(createMotionTools({ sessionId: 'chat1', canRender: false }).video_render).toBeUndefined()
  })

  it('video_probe reads an attachment by its ref, with no working folder', async () => {
    const tools = createMotionTools({ sessionId: 'chat1', canRender: true })
    const out = String(await run(tools, 'video_probe', { paths: [refA] }))
    expect(out).toContain(refA)
    expect(out).toContain('640x360')
    expect(out).toContain('audio')
    expect(String(await run(tools, 'video_probe', { paths: ['vdo_naoexiste.mp4'] }))).toMatch(/attachment not found/)
  })

  it('reads a video back by the player URL it handed out', async () => {
    const tools = createMotionTools({ sessionId: 'chat1', canRender: true })
    // The URL the render hands over is what the agent has in hand afterwards.
    const result = (await run(tools, 'video_render', {
      edl: { sources: { A: refA }, ranges: [{ source: 'A', start: 0, end: 1 }], snap: false },
    })) as { videoUrl: string; path: string }

    const out = String(await run(tools, 'video_probe', { paths: [result.videoUrl] }))
    expect(out).toContain(path.basename(result.path))
    expect(out).toContain('640x360')
    // A dropped slash does not send it back to a relative path.
    expect(String(await run(tools, 'video_probe', { paths: [result.videoUrl.replace('://', ':/')] }))).toContain('640x360')
    // An id no longer in the registry says what happened.
    expect(String(await run(tools, 'video_probe', { paths: ['orbit-video://vid_naoexiste'] }))).toMatch(/video not found/)
  }, 60_000)

  it('video_timeline saves the sheet in the gallery and only puts it in the reply with show: true', async () => {
    const tools = createMotionTools({ sessionId: 'chat1', canRender: true })

    const hidden = (await run(tools, 'video_timeline', { path: refA, start: 0, end: 1.5, frames: 3 })) as {
      message: string
      mediaUrl: string
      shown: boolean
    }
    // The image exists outside the model's context: it is an item of this conversation's gallery.
    expect(hidden.mediaUrl).toMatch(/^orbit-media:\/\//)
    expect(hidden.shown).toBe(false)
    expect(hidden.message).toContain("NOT in the user's chat")
    const entry = await media.getMediaEntry(media.mediaIdFromUrl(hidden.mediaUrl)!)
    expect(entry).toMatchObject({ kind: 'image', source: 'chat', sessionId: 'chat1' })

    // With no transcript (a track without speech) silence is not declared: the whole
    // window was reported as silent.
    expect(hidden.message).toContain('No transcript cached')
    expect(hidden.message).not.toContain('Silences ≥0.4s')

    const shown = (await run(tools, 'video_timeline', { path: refA, start: 0, end: 1.5, frames: 3, show: true })) as {
      message: string
      mediaUrl: string
      shown: boolean
    }
    expect(shown.shown).toBe(true)
    expect(shown.message).toContain('attached to your reply')
    // Each look is its own item — the second one does not overwrite the first.
    expect(shown.mediaUrl).not.toBe(hidden.mediaUrl)
  }, 60_000)

  it('cuts and joins two attachments: the output goes to the app, enters the gallery and vanishes on delete', async () => {
    const tools = createMotionTools({ sessionId: 'chat1', canRender: true })
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
    // The output stays in this conversation's folder, and not next to the attachment.
    const rendersDir = path.join(motionPiecesDir('chat1'), 'renders')
    expect(path.dirname(result.path!)).toBe(rendersDir)
    expect(await exists(result.path!)).toBe(true)
    expect(await exists(path.join(path.dirname(await mediaPath(refA)), 'edit', path.basename(result.path!)))).toBe(false)

    const items = (await media.listMedia({ kind: 'video' })).filter((e) => e.path === result.path)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ source: 'chat', sessionId: 'chat1' })
    expect(items[0].durationMs).toBeGreaterThan(1500)

    // Deleting in the gallery erases the file from disk.
    expect(await media.deleteMedia(items[0].id)).toBe(true)
    expect(await exists(result.path!)).toBe(false)
    // …and the source attachment remains intact.
    expect(await exists(await mediaPath(refA))).toBe(true)
  }, 60_000)

  it('each final video is an item (its own name); the preview is a single one and stays out of the gallery', async () => {
    const tools = createMotionTools({ sessionId: 'chat2', canRender: true })
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

  it('redoing the SAME render file does not create a new card in the gallery', async () => {
    const file = path.join(motionPiecesDir('chat3'), 'renders', 'peca.mp4')
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
