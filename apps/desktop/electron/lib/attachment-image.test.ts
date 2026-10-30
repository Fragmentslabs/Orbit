import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * What is left of an image pasted into the chat.
 *
 * The bubble keeps a thumbnail on purpose — duplicating the whole photo in the
 * history would resend it on every turn. But the ORIGINAL has to stay
 * reachable: it is what the viewer zooms into and what the copy and
 * save buttons deliver. Keeping only the thumbnail makes the preview stretch 320px to the
 * whole screen and "save" return the thumbnail instead of the photo.
 */

const userData = path.join(os.tmpdir(), `orbit-attachment-test-${process.pid}`)

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

/** A photo large enough for the 320px thumbnail to be a real loss. */
async function makePhoto(): Promise<Buffer> {
  return sharp({ create: { width: 1600, height: 900, channels: 3, background: '#3b7dd8' } })
    .png()
    .toBuffer()
}

describe('image pasted in the chat', () => {
  it('the gallery stores the ORIGINAL, at the size it arrived', async () => {
    const original = await makePhoto()
    const url = await media.saveMedia(original, 'png', {
      source: 'user',
      sessionId: 'session1',
      name: 'pasted.png',
    })

    const stored = await media.readMedia(media.mediaIdFromUrl(url)!)
    const meta = await sharp(stored!.buffer).metadata()
    expect(meta.width).toBe(1600)
    expect(meta.height).toBe(900)
  })

  it('the gallery reference is usable as an image source', async () => {
    // It is what the viewer receives instead of the thumbnail, and what the copy
    // and save buttons resolve.
    const url = await media.saveMedia(await makePhoto(), 'png', { source: 'user', sessionId: 'session1' })
    expect(url).toMatch(/^orbit-media:\/\/img_\w+\.png$/)
    expect(media.mediaIdFromUrl(url)).toBeTruthy()
    expect(await media.readMedia(media.mediaIdFromUrl(url)!)).not.toBeNull()
  })

  it('each format comes back with ITS extension, including SVG', async () => {
    // "Save" uses this to name the file. Deducing the extension from the content
    // type made `image/svg+xml` become ".svg+xml", and before that the vector
    // came out saved as PNG — because the type map did not know SVG. The id, which
    // we choose ourselves when writing, does not depend on anyone remembering anything.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'
    const cases: [Buffer, string, string][] = [
      [await makePhoto(), 'png', 'image/png'],
      [Buffer.from(svg, 'utf8'), 'svg', 'image/svg+xml'],
    ]
    for (const [bytes, ext, contentType] of cases) {
      const url = await media.saveMedia(bytes, ext, { source: 'chat', sessionId: 'session1' })
      const loaded = await media.readMedia(media.mediaIdFromUrl(url)!)
      expect(loaded!.ext).toBe(ext)
      expect(loaded!.contentType).toBe(contentType)
    }
  })

  it('the bubble thumbnail is small enough for the loss to matter', async () => {
    // Pins the fix's premise: if the thumbnail were already large, stretching it
    // would not be a problem and this whole path would be unnecessary.
    const original = await makePhoto()
    const thumb = await sharp(original)
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer()
    const meta = await sharp(thumb).metadata()
    expect(meta.width).toBe(320)
    expect(thumb.length).toBeLessThan(original.length / 4)
  })
})
