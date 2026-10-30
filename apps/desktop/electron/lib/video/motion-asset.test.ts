import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const work = path.join(os.tmpdir(), `orbit-motion-asset-${process.pid}`)
const attachments = path.join(work, 'attachments')
const folder = path.join(work, 'piece')

const resolved: Record<string, { kind: string; id: string; file: string; name: string }> = {}
vi.mock('../attachment-ref', () => ({
  resolveAttachmentRef: async (ref: string) => resolved[ref.replace(/^ref\s+/, '')] ?? null,
}))
vi.mock('./ffmpeg', () => ({
  probeMedia: async (file: string) => ({
    file,
    durationMs: 12400,
    sizeBytes: 14_200_000,
    format: 'mov,mp4',
    video: [{ index: 0, codec: 'h264', width: 1920, height: 1080, fps: 30, rotation: 0 }],
    audio: file.includes('silent') ? [] : [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2 }],
    display: { width: 1920, height: 1080 },
  }),
}))

const { assetFileName, importAttachmentInto } = await import('./motion-asset')

async function attach(id: string, kind: string, name: string, content = 'bytes', ext = path.extname(name)): Promise<void> {
  const file = path.join(attachments, `${id}${ext}`)
  await fsp.writeFile(file, content)
  resolved[id] = { kind, id, file, name }
}

beforeAll(async () => {
  await fsp.mkdir(attachments, { recursive: true })
})
afterAll(async () => {
  await fsp.rm(work, { recursive: true, force: true })
})
beforeEach(async () => {
  await fsp.rm(folder, { recursive: true, force: true })
})

describe('assetFileName', () => {
  it('safe name: no space, no accent, no separator, lowercase extension', () => {
    expect(assetFileName(undefined, 'Minha Aula Ótima!.MP4', '.mp4')).toBe('Minha-Aula-Otima.mp4')
    expect(assetFileName('../../etc/passwd', 'x.mp4', '.mp4')).toBe('passwd.mp4')
    expect(assetFileName('meu clip', 'orig.mov', '.mov')).toBe('meu-clip.mov')
    expect(assetFileName('', '', '.gif')).toBe('asset.gif')
  })
})

describe('importAttachmentInto', () => {
  it('copies the video into the folder and says how to use it — sound included', async () => {
    await attach('vdo_a', 'video', 'Depoimento Cliente.mp4', 'VIDEO')
    const out = await importAttachmentInto(folder, 'vdo_a')
    expect(out).toMatchObject({ kind: 'video', name: 'Depoimento-Cliente.mp4' })
    expect(await fsp.readFile(path.join(folder, 'Depoimento-Cliente.mp4'), 'utf8')).toBe('VIDEO')
    expect(out.report).toContain('Copied: video "Depoimento Cliente.mp4" → Depoimento-Cliente.mp4')
    expect(out.report).toContain('12.4 s, 1920x1080 @ 30 fps')
    expect(out.report).toContain('<video src="Depoimento-Cliente.mp4">')
    expect(out.report).toContain('MIXED into the render unless you add the muted attribute')
  })

  it('video with no audio stream: it does not mention sound to manage', async () => {
    await attach('vdo_s', 'video', 'silent.mp4')
    const out = await importAttachmentInto(folder, 'vdo_s')
    expect(out.report).toContain('no audio stream')
    expect(out.report).not.toContain('MIXED')
  })

  it('GIF: says it is deterministic and gives the data-start; photo: only the <img>', async () => {
    await attach('img_g', 'image', 'dança.gif')
    const gif = await importAttachmentInto(folder, 'img_g')
    expect(gif.name).toBe('danca.gif')
    expect(gif.report).toContain('Copied: GIF')
    expect(gif.report).toContain('data-loop="false"')

    await attach('img_p', 'image', 'foto.png')
    const photo = await importAttachmentInto(folder, 'img_p')
    expect(photo.report).toContain('object-view-box crops it')
    expect(photo.report).not.toContain('GIF')
  })

  it('audio: tells you to declare it in audio.json', async () => {
    await attach('aud_v', 'audio', 'voz.mp3')
    const out = await importAttachmentInto(folder, 'aud_v')
    expect(out.report).toContain('audio.json')
    expect(out.report).toContain('"file": "voz.mp3"')
  })

  it('the same attachment twice gives the same file; different content with the same name gets another', async () => {
    await attach('vdo_r', 'video', 'clip.mp4', 'AAAA')
    const first = await importAttachmentInto(folder, 'vdo_r')
    const again = await importAttachmentInto(folder, 'vdo_r')
    expect(again.name).toBe(first.name)
    expect(again.report).toContain('Already in the folder')

    await attach('vdo_other', 'video', 'clip.mp4', 'BBBBBBB')
    const other = await importAttachmentInto(folder, 'vdo_other')
    expect(other.name).toBe('clip-2.mp4')
    expect((await fsp.readdir(folder)).sort()).toEqual(['clip-2.mp4', 'clip.mp4'])
  })

  it('the requested name wins, keeping the original extension when it is missing', async () => {
    await attach('vdo_n', 'video', 'qualquer.mov')
    expect((await importAttachmentInto(folder, 'vdo_n', 'abertura')).name).toBe('abertura.mov')
  })

  it('a reference that is not from an attachment is an error saying what to use', async () => {
    await expect(importAttachmentInto(folder, 'vdo_naoexiste')).rejects.toThrow(/attachment not found: vdo_naoexiste.*vdo_…/)
    await expect(importAttachmentInto(folder, '/etc/passwd')).rejects.toThrow(/attachment not found/)
    // Nothing was created by an invalid reference.
    expect(await fsp.readdir(folder).catch(() => [])).toEqual([])
  })
})
