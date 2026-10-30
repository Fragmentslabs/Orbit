import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const work = path.join(os.tmpdir(), `orbit-attachments-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work },
  protocol: {},
}))

const mediaEntries: Record<string, { id: string; path: string; name?: string }> = {}
const deleteHooks = new Map<string, (entry: { id: string; path: string }) => Promise<void>>()
vi.mock('./media', () => ({
  setMediaDeleteHook: (kind: string, hook: (entry: { id: string; path: string }) => Promise<void>) => {
    deleteHooks.set(kind, hook)
  },
  SAFE_AUDIO_ID: /^aud_[a-z0-9]+\.(wav|mp3)$/,
  audioMediaId: (value: string) => (/^aud_[a-z0-9]+\.(wav|mp3)$/.test(value.trim()) ? value.trim() : null),
  mediaIdFromUrl: (value: string) => {
    const id = value.replace('orbit-media://', '')
    return /^img_[a-z0-9]+\.(png|gif)$/.test(id) ? id : null
  },
  getMediaEntry: async (id: string) => mediaEntries[id] ?? null,
  registerAudioMedia: async () => {},
}))

const unregistered: string[] = []
vi.mock('./video/store', () => ({
  unregisterVideosFor: async (file: string) => {
    unregistered.push(file)
  },
}))

const {
  MAX_VIDEO_ATTACHMENT_BYTES,
  isVideoFile,
  looksLikeAttachmentRef,
  resolveAttachmentRef,
  saveVideoAttachment,
  videoAttachmentDir,
  videoAttachmentExt,
  videoPathFromFileUrl,
} = await import('./attachment-ref')

beforeAll(async () => {
  await fsp.mkdir(work, { recursive: true })
})
afterAll(async () => {
  await fsp.rm(work, { recursive: true, force: true })
})

describe('attachment type', () => {
  it('video by MIME or by extension', () => {
    expect(isVideoFile('video/mp4')).toBe(true)
    expect(isVideoFile('', 'Class.MOV')).toBe(true)
    expect(isVideoFile('audio/mpeg', 'a.mp3')).toBe(false)
    expect(isVideoFile('image/gif', 'a.gif')).toBe(false)
  })

  it('stored extension: MIME first, name after, otherwise refuse', () => {
    expect(videoAttachmentExt('video/quicktime')).toBe('mov')
    expect(videoAttachmentExt('', 'clip.WEBM')).toBe('webm')
    expect(videoAttachmentExt('video/x-unknown', 'clip')).toBeNull()
  })
})

describe('looksLikeAttachmentRef', () => {
  it('recognizes the three families, with or without "ref " and URL; a project path is not a reference', () => {
    for (const ref of ['vdo_abc123.mp4', 'ref aud_abc.wav', 'orbit-media://img_ab1.png', 'orbit-audio://aud_x1.mp3']) {
      expect(looksLikeAttachmentRef(ref), ref).toBe(true)
    }
    for (const ref of ['edit/clip.mp4', '/Users/a/vdo_x.mp4', 'video.mp4', '']) {
      expect(looksLikeAttachmentRef(ref), ref).toBe(false)
    }
  })
})

describe('saveVideoAttachment', () => {
  it('stores bytes and returns a resolvable reference, with the original name', async () => {
    const saved = await saveVideoAttachment({ bytes: Buffer.from('fake') }, 'mp4', { name: 'My Class.mp4', sessionId: 's1' })
    expect(saved.id).toMatch(/^vdo_[a-z0-9]+\.mp4$/)
    expect(saved.file).toBe(path.join(videoAttachmentDir(), saved.id))
    const resolved = await resolveAttachmentRef(saved.id)
    expect(resolved).toMatchObject({ kind: 'video', id: saved.id, file: saved.file, name: 'My Class.mp4' })
  })

  it('copies from a file on disk (the path of drag/pick)', async () => {
    const source = path.join(work, 'original.mov')
    await fsp.writeFile(source, 'movie-bytes')
    const saved = await saveVideoAttachment({ copyFrom: source }, 'mov', { name: 'original.mov' })
    expect(await fsp.readFile(saved.file, 'utf8')).toBe('movie-bytes')
    expect(saved.size).toBe(11)
    // The original is not touched.
    expect(await fsp.readFile(source, 'utf8')).toBe('movie-bytes')
  })

  it('refuses what is not a file and an extension we do not store', async () => {
    await expect(saveVideoAttachment({ copyFrom: work }, 'mp4')).rejects.toThrow(/not a file/)
    await expect(saveVideoAttachment({ bytes: Buffer.from('x') }, 'exe')).rejects.toThrow(/unsupported video format/)
    expect(MAX_VIDEO_ATTACHMENT_BYTES).toBeGreaterThan(1024 ** 3)
  })
})

describe('resolveAttachmentRef', () => {
  it('accepts the path the note delivers and the "ref " prefix', async () => {
    const saved = await saveVideoAttachment({ bytes: Buffer.from('v') }, 'webm', { name: 'a.webm' })
    expect((await resolveAttachmentRef(`ref ${saved.id}`))?.id).toBe(saved.id)
    expect((await resolveAttachmentRef(saved.file))?.id).toBe(saved.id)
  })

  it('only opens attachments: nothing outside the folder, nothing that is not there', async () => {
    expect(await resolveAttachmentRef('/etc/passwd')).toBeNull()
    expect(await resolveAttachmentRef('../vdo_a.mp4')).toBeNull()
    expect(await resolveAttachmentRef('vdo_missing.mp4')).toBeNull()
    expect(await resolveAttachmentRef(path.join(work, 'original.mov'))).toBeNull()
    expect(await resolveAttachmentRef('')).toBeNull()
  })

  it('image and audio come from the media library', async () => {
    const image = path.join(work, 'photo.gif')
    await fsp.writeFile(image, 'GIF89a')
    mediaEntries['img_ab1.gif'] = { id: 'img_ab1.gif', path: image, name: 'dance.gif' }
    // A stored GIF resolves through the scheme URL, with the original name.
    expect(await resolveAttachmentRef('orbit-media://img_ab1.gif')).toMatchObject({ kind: 'image', name: 'dance.gif' })
    mediaEntries['img_ab2.png'] = { id: 'img_ab2.png', path: image, name: 'photo.png' }
    expect(await resolveAttachmentRef('img_ab2.png')).toMatchObject({ kind: 'image', file: image, name: 'photo.png' })
    // Index entry whose file vanished: it does not resolve.
    mediaEntries['img_ab3.png'] = { id: 'img_ab3.png', path: path.join(work, 'gone.png') }
    expect(await resolveAttachmentRef('img_ab3.png')).toBeNull()
  })
})

describe('videoPathFromFileUrl', () => {
  it('undoes the renderer file://, with spaces and accents', () => {
    // The path and the platform's NATIVE form: on Windows fileURLToPath refuses
    // a POSIX path (no drive), and the renderer always sends the path of the
    // machine. Building the URL from it tests the real contract.
    const file = path.join(os.tmpdir(), 'a b', 'Meu V\u00eddeo.mp4')
    expect(videoPathFromFileUrl(pathToFileURL(file).href)).toBe(file)
  })

  it('only serves a real video file: the declared name does not count', () => {
    expect(videoPathFromFileUrl('file:///etc/passwd')).toBeNull()
    expect(videoPathFromFileUrl('file:///Users/a/secret.txt')).toBeNull()
    expect(videoPathFromFileUrl('data:video/mp4;base64,AAAA')).toBeNull()
    expect(videoPathFromFileUrl('/Users/a/clip.mp4')).toBeNull()
  })
})

describe('deleting a video attached in the gallery', () => {
  it('the type hook removes the video from the player and the name from the attachment index', async () => {
    const saved = await saveVideoAttachment({ bytes: Buffer.from('v') }, 'mp4', { name: 'Class.mp4' })
    expect((await resolveAttachmentRef(saved.id))?.name).toBe('Class.mp4')

    const hook = deleteHooks.get('video')
    expect(hook).toBeTypeOf('function')
    await hook!({ id: saved.id, path: saved.file })

    expect(unregistered).toContain(saved.file)
    // Without the name in the index the reference still resolves (the file is deleted by
    // whoever calls the hook), only through the id — no label is left of a deleted video.
    expect((await resolveAttachmentRef(saved.id))?.name).toBe(saved.id)
  })
})

describe('deleting a video takes the cached transcription along', () => {
  it('deletes edit/transcripts/<file>.json next to the video', async () => {
    const saved = await saveVideoAttachment({ bytes: Buffer.from('v') }, 'mp4', { name: 'speech.mp4' })
    const cache = path.join(path.dirname(saved.file), 'edit', 'transcripts', `${path.basename(saved.file)}.json`)
    await fsp.mkdir(path.dirname(cache), { recursive: true })
    await fsp.writeFile(cache, '{}')

    await deleteHooks.get('video')!({ id: saved.id, path: saved.file })

    await expect(fsp.stat(cache)).rejects.toThrow()
  })
})
