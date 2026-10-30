import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The motion piece enters the gallery through a record that is NOT an Orbit
 * file: the composition is a folder of the project. What these tests protect are the
 * two consequences of that — registering the same piece again does not create a second
 * card, and the item's `path` points to the COVER, never to the file of whoever made
 * the piece.
 */

const userData = path.join(os.tmpdir(), `orbit-motion-media-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

let media: typeof import('./media')

beforeAll(async () => {
  media = await import('./media')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('saveMotionMedia', () => {
  it('registers the piece only once: registering again updates the SAME item', async () => {
    const first = await media.saveMotionMedia(Buffer.from('cover-1'), {
      motionId: 'mv_abc123',
      title: 'Abertura',
    })
    const second = await media.saveMotionMedia(Buffer.from('cover-2'), {
      motionId: 'mv_abc123',
      title: 'Abertura v2',
    })
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.name).toBe('Abertura v2')
    const items = (await media.listMedia({ kind: 'motion' })).filter((i) => i.motionId === 'mv_abc123')
    expect(items).toHaveLength(1)
  })

  it('the path points at the COVER, never at the project piece', async () => {
    const entry = await media.saveMotionMedia(Buffer.from('cover'), {
      motionId: 'mv_def456',
      title: 'Closing',
      directory: '/tmp/some-project',
    })
    expect(entry.kind).toBe('motion')
    expect(entry.motionId).toBe('mv_def456')
    // Deleting the gallery item deletes the thumbnail — the only byte that is OURS. The
    // composition stays untouched in the project's folder.
    expect(entry.path.startsWith(userData)).toBe(true)
    expect(path.basename(entry.path)).toBe(entry.id)
    expect(entry.thumb).toBe(entry.id)
    await expect(fsp.readFile(entry.path, 'utf8')).resolves.toBe('cover')
    // The project stays recorded, so Media can group it and the item survives the conversation.
    expect(entry.directory).toBe('/tmp/some-project')
  })

  it('without a capture the piece comes in anyway, just without a cover', async () => {
    const entry = await media.saveMotionMedia(null, { motionId: 'mv_nocover', title: 'Draft' })
    expect(entry.kind).toBe('motion')
    expect(entry.thumb).toBeUndefined()
    expect(entry.size).toBe(0)
  })
})

const exists = (target: string) =>
  fsp.stat(target).then(
    () => true,
    () => false,
  )

describe('video in the gallery', () => {
  async function videoFile(name: string): Promise<string> {
    const dir = path.join(userData, 'orbit-data', 'video-attachments')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    await fsp.writeFile(file, 'video-bytes')
    return file
  }

  it('comes in as a video type, with cover, duration and the player URL', async () => {
    const file = await videoFile('vdo_a1.mp4')
    const entry = await media.saveVideoMedia(Buffer.from('png'), {
      id: 'vdo_a1.mp4',
      file,
      size: 11,
      name: 'Interview.mp4',
      source: 'user',
      sessionId: 's1',
      durationMs: 12_400,
      width: 1920,
      height: 1080,
      videoUrl: 'orbit-video://vid_x',
    })
    expect(entry).toMatchObject({ kind: 'video', durationMs: 12_400, videoUrl: 'orbit-video://vid_x', path: file, source: 'user' })
    expect(entry.thumb).toBe('vdp_a1.png')
    const listed = await media.listMedia({ kind: 'video' })
    expect(listed.map((e) => e.id)).toContain('vdo_a1.mp4')
  })

  it('registering the same id again updates the item (does not create another)', async () => {
    const file = await videoFile('vdo_b2.mp4')
    await media.saveVideoMedia(null, { id: 'vdo_b2.mp4', file, size: 1, source: 'user', name: 'one' })
    await media.saveVideoMedia(null, { id: 'vdo_b2.mp4', file, size: 1, source: 'user', name: 'two' })
    const items = (await media.listMedia({ kind: 'video' })).filter((e) => e.id === 'vdo_b2.mp4')
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('two')
  })

  it('deleting removes the video FILE, the cover and the record — frees the space', async () => {
    const file = await videoFile('vdo_c3.mp4')
    const entry = await media.saveVideoMedia(Buffer.from('png'), { id: 'vdo_c3.mp4', file, size: 11, source: 'user' })
    const cover = path.join(userData, 'orbit-data', 'artifacts', entry.thumb!)
    expect(await exists(file)).toBe(true)
    expect(await exists(cover)).toBe(true)

    expect(await media.deleteMedia('vdo_c3.mp4')).toBe(true)

    expect(await exists(file)).toBe(false)
    expect(await exists(cover)).toBe(false)
    expect(await media.getMediaEntry('vdo_c3.mp4')).toBeNull()
  })

  it('the type hook runs BEFORE the record disappears; if it fails, the item stays to try again', async () => {
    const file = await videoFile('vdo_d4.mp4')
    await media.saveVideoMedia(null, { id: 'vdo_d4.mp4', file, size: 11, source: 'user' })
    const seen: string[] = []
    media.setMediaDeleteHook('video', async (entry) => {
      seen.push(entry.id)
      throw new Error('unavailable')
    })
    await expect(media.deleteMedia('vdo_d4.mp4')).rejects.toThrow('unavailable')
    expect(seen).toEqual(['vdo_d4.mp4'])
    expect(await exists(file)).toBe(true)
    expect(await media.getMediaEntry('vdo_d4.mp4')).not.toBeNull()

    media.setMediaDeleteHook('video', async () => {})
    expect(await media.deleteMedia('vdo_d4.mp4')).toBe(true)
    expect(await exists(file)).toBe(false)
  })

  it('an id that is not video, image, audio nor artifact is still refused', async () => {
    expect(await media.deleteMedia('vdo_x.exe')).toBe(false)
    expect(await media.deleteMedia('../../etc/passwd')).toBe(false)
  })
})

describe('deleting a motion piece', () => {
  it('calls the type hook with the piece — it is what deletes the composition — and removes the cover', async () => {
    const entry = await media.saveMotionMedia(Buffer.from('cover'), { motionId: 'mv_delete1', title: 'Piece' })
    const asked: Array<string | undefined> = []
    media.setMediaDeleteHook('motion', async (e) => {
      asked.push(e.motionId)
    })
    expect(await media.deleteMedia(entry.id)).toBe(true)
    expect(asked).toEqual(['mv_delete1'])
    expect(await exists(entry.path)).toBe(false)
    expect(await media.getMediaEntry(entry.id)).toBeNull()
  })
})

describe('disk usage', () => {
  it('counts the videos from the record, and deleting removes it from the count', async () => {
    const dir = path.join(userData, 'orbit-data', 'video-attachments')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'vdo_u9.mp4')
    await fsp.writeFile(file, Buffer.alloc(4096))
    const before = await media.mediaDiskUsage()
    await media.saveVideoMedia(null, { id: 'vdo_u9.mp4', file, size: 4096, source: 'user' })
    const during = await media.mediaDiskUsage()
    expect(during.bytes - before.bytes).toBe(4096)
    expect(during.count - before.count).toBe(1)

    await media.deleteMedia('vdo_u9.mp4')
    const after = await media.mediaDiskUsage()
    expect(after.bytes).toBe(before.bytes)
  })
})
