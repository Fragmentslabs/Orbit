import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Photo, GIF, audio and video in the Sources tab. Real modules (media, audio,
 * attachments, folder scope) over a temporary userData; the video uses the app's
 * ffmpeg and its part skips when the machine does not have it.
 */

const desktop = path.resolve(__dirname, '../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const userData = path.join(os.tmpdir(), `orbit-session-materials-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => desktop, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const materials = await import('./session-materials')
const media = await import('./media')
const documents = await import('./session-documents')
const { runFfmpeg } = await import('./video/ffmpeg')
const { motionFfmpegArgs } = await import('./video/motion-render-args')

const exists = (target: string) =>
  fsp.stat(target).then(
    () => true,
    () => false,
  )

let png: string
let gif: string
let wav: string

beforeAll(async () => {
  await fsp.mkdir(userData, { recursive: true })
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).png().toBuffer()
  png = image.toString('base64')
  // A minimal, valid GIF (1x1) — the content does not matter, only the preserved extension.
  gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64').toString('base64')
  wav = Buffer.concat([Buffer.from('RIFF$\0\0\0WAVEfmt ', 'binary'), Buffer.alloc(24)]).toString('base64')
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('materialKindOf', () => {
  it('classifies by MIME or by extension', () => {
    expect(materials.materialKindOf('image/gif', 'a.gif')).toBe('image')
    expect(materials.materialKindOf('', 'PHOTO.JPG')).toBe('image')
    expect(materials.materialKindOf('audio/mpeg', 'a.mp3')).toBe('audio')
    expect(materials.materialKindOf('', 'clip.MOV')).toBe('video')
    expect(materials.materialKindOf('application/pdf', 'a.pdf')).toBeNull()
    expect(materials.materialKindOf('', 'spreadsheet.xlsx')).toBeNull()
  })
})

describe('addSessionMaterial / listSessionMaterials', () => {
  it('photo and GIF come into the conversation, with the img_ reference and the extension preserved', async () => {
    const photo = await materials.addSessionMaterial('s1', { filename: 'photo.png', mime: 'image/png', data: png }, false)
    const animated = await materials.addSessionMaterial('s1', { filename: 'dance.gif', mime: 'image/gif', data: gif }, false)
    expect(photo.ok && photo.material.id).toMatch(/^img_.*\.png$/)
    expect(animated.ok && animated.material).toMatchObject({ kind: 'image', animated: true, name: 'dance.gif', shared: false })
    expect(animated.ok && animated.material.id).toMatch(/\.gif$/)

    const list = await materials.listSessionMaterials('s1')
    expect(list.own.map((m) => m.name).sort()).toEqual(['dance.gif', 'photo.png'])
    expect(list.shared).toEqual([])
    expect(list.bytes).toBeGreaterThan(0)
  })

  it('audio becomes aud_ and shows up without a cover', async () => {
    const result = await materials.addSessionMaterial('s2', { filename: 'voice.wav', mime: 'audio/wav', data: wav }, false)
    expect(result.ok).toBe(true)
    const [audio] = (await materials.listSessionMaterials('s2')).own
    expect(audio).toMatchObject({ kind: 'audio', name: 'voice.wav', thumbUrl: null })
    expect(audio.id).toMatch(/^aud_/)
  })

  it('a type the tab does not store is refused with the reason', async () => {
    const result = await materials.addSessionMaterial('s1', { filename: 'doc.pdf', mime: 'application/pdf', data: 'AAAA' }, false)
    expect(result.ok).toBe(false)
  })

  it('only what the USER brought shows up: the image the agent generated is output, not material', async () => {
    await media.saveMedia(Buffer.from(png, 'base64'), 'png', { source: 'chat', sessionId: 's3', name: 'generated.png' })
    expect((await materials.listSessionMaterials('s3')).own).toEqual([])
  })

  it('what belongs to one conversation does not show up in another', async () => {
    const mine = await materials.listSessionMaterials('s1')
    const other = await materials.listSessionMaterials('s2')
    expect(mine.own.some((m) => m.name === 'voice.wav')).toBe(false)
    expect(other.own.some((m) => m.name === 'photo.png')).toBe(false)
  })
})

describe('folder scope', () => {
  it('sharing does not change the reference; without a folder, there is no one to share with', async () => {
    await documents.setDraftFolder(null)
    const added = await materials.addSessionMaterial('draft', { filename: 'a.png', mime: 'image/png', data: png }, true)
    // Without a folder, "shared" falls back to the conversation.
    expect(added.ok && added.material.shared).toBe(false)
    const id = added.ok ? added.material.id : ''
    const denied = await materials.setMaterialShared('draft', id, true)
    expect(denied.ok).toBe(false)

    await documents.setDraftFolder('folder1')
    expect(await materials.setMaterialShared('draft', id, true)).toEqual({ ok: true })
    const shared = await materials.listSessionMaterials('draft')
    expect(shared.shared.map((m) => m.id)).toEqual([id])
    expect(shared.own.some((m) => m.id === id)).toBe(false)

    expect(await materials.setMaterialShared('draft', id, false)).toEqual({ ok: true })
    const back = await materials.listSessionMaterials('draft')
    expect(back.shared).toEqual([])
    expect(back.own.map((m) => m.id)).toContain(id)
  })

  it('refuses an id that is not a material of this conversation', async () => {
    const result = await materials.setMaterialShared('s2', 'img_missing.png', true)
    expect(result).toMatchObject({ ok: false })
  })

  it('what was brought in the draft moves to the session when it is born', async () => {
    await documents.setDraftFolder(null)
    const added = await materials.addSessionMaterial('draft', { filename: 'draft.png', mime: 'image/png', data: png }, false)
    const id = added.ok ? added.material.id : ''
    expect((await materials.listSessionMaterials('newone')).own.map((m) => m.id)).not.toContain(id)

    expect(await materials.adoptDraftMaterials('newone')).toBeGreaterThan(0)

    expect((await materials.listSessionMaterials('newone')).own.map((m) => m.id)).toContain(id)
    expect((await materials.listSessionMaterials('draft')).own.map((m) => m.id)).not.toContain(id)
  })
})

describe('deleting frees the space', () => {
  it('deleting from the gallery takes the file off disk and out of the tab', async () => {
    const added = await materials.addSessionMaterial('s4', { filename: 'sai.png', mime: 'image/png', data: png }, false)
    const material = added.ok ? added.material : null
    const entry = await media.getMediaEntry(material!.id)
    expect(await exists(entry!.path)).toBe(true)

    expect(await media.deleteMedia(material!.id)).toBe(true)

    expect(await exists(entry!.path)).toBe(false)
    expect((await materials.listSessionMaterials('s4')).own).toEqual([])
  })
})

describe('describeMaterialsForAgent', () => {
  it('one line per material: reference, type, name, facts and where it came from', () => {
    const text = materials.describeMaterialsForAgent({
      shared: [
        { id: 'vdo_a.mp4', kind: 'video', name: 'Class.mp4', sizeBytes: 14_200_000, createdAt: 1, durationMs: 12_400, width: 1920, height: 1080, thumbUrl: null, playUrl: null, shared: true, animated: false },
      ],
      own: [
        { id: 'img_b.gif', kind: 'image', name: 'dance.gif', sizeBytes: 500_000, createdAt: 2, thumbUrl: null, playUrl: null, shared: false, animated: true },
      ],
    })
    expect(text.split('\n')).toEqual([
      'vdo_a.mp4: video "Class.mp4" (12.4 s, 1920x1080, 14.2 MB, folder material, shared with the other chats of the folder)',
      'img_b.gif: image "dance.gif" (animated GIF, 0.5 MB, attached in this conversation)',
    ])
  })
})

describe.skipIf(!hasFfmpeg)('video in the tab (real ffmpeg)', () => {
  async function clip(file: string): Promise<void> {
    const frame = Buffer.alloc(64 * 64 * 4, 180)
    await runFfmpeg(motionFfmpegArgs({ width: 64, height: 64, captureWidth: 64, captureHeight: 64, fps: 5, format: 'mp4', output: file }), {
      stdin: Readable.from([Buffer.concat(Array.from({ length: 10 }, () => frame))]),
    })
  }

  it('a file video comes in by path: it is copied, probed, gets a cover and becomes a gallery item', async () => {
    const source = path.join(userData, 'Interview.mp4')
    await clip(source)
    const result = await materials.addSessionMaterial('sv', { filename: 'Interview.mp4', mime: 'video/mp4', path: source }, false)
    expect(result.ok).toBe(true)
    const material = result.ok ? result.material : null
    expect(material).toMatchObject({ kind: 'video', name: 'Interview.mp4' })
    expect(material!.id).toMatch(/^vdo_/)
    expect(material!.durationMs).toBeGreaterThan(1500)
    expect(material!.thumbUrl).toMatch(/^orbit-artifact:\/\/vdp_/)
    expect(material!.playUrl).toMatch(/^orbit-video:\/\//)
    // The original stays where it was; the copy belongs to the app.
    expect(fs.existsSync(source)).toBe(true)
    const entry = await media.getMediaEntry(material!.id)
    expect(entry!.path.startsWith(userData)).toBe(true)
    expect((await media.listMedia({ kind: 'video' })).map((e) => e.id)).toContain(material!.id)

    // Deleting removes the copy (and only it).
    expect(await media.deleteMedia(material!.id)).toBe(true)
    expect(fs.existsSync(entry!.path)).toBe(false)
    expect(fs.existsSync(source)).toBe(true)
  })

  it('a file that is not really a video is refused and leaves no copy', async () => {
    const fake = path.join(userData, 'fake.mp4')
    await fsp.writeFile(fake, 'this is not a video')
    const result = await materials.addSessionMaterial('sv2', { filename: 'fake.mp4', mime: 'video/mp4', path: fake }, false)
    expect(result.ok).toBe(false)
    expect((await materials.listSessionMaterials('sv2')).own).toEqual([])
  })

  it('the path must be of a video file: the declared name does not count', async () => {
    const secret = path.join(userData, 'secret.txt')
    await fsp.writeFile(secret, 'confidential')
    const result = await materials.addSessionMaterial('sv3', { filename: 'innocent.mp4', mime: 'video/mp4', path: secret }, false)
    expect(result).toMatchObject({ ok: false })
  })
})
