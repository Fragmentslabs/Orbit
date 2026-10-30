import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Where describe_image gets the image from.
 *
 * The turn's attachment lives in a registry that dies with the turn. If that were the
 * only source, "look before editing" would only work in the message in which the
 * photo arrived — and the next request ("now write on the jacket") would be done
 * in the dark. The gallery source is what makes the orientation true, so
 * it is what these tests protect.
 */

const userData = path.join(os.tmpdir(), `orbit-describe-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

/** Turn registry, in memory, and a describeImage that only keeps what
 *  it received — what is to be checked is WHICH image reached it. */
const turnImages: { url: string }[] = []
const received: { imageDataUrl?: string } = {}

vi.mock('../vision', () => ({
  getTurnImages: () => turnImages,
  describeImage: async (opts: { imageDataUrl: string }) => {
    received.imageDataUrl = opts.imageDataUrl
    return 'descrição'
  },
}))

type ToolLike = { execute: (input: Record<string, unknown>) => Promise<unknown> }

let tool: ToolLike
let media: typeof import('../media')
let galleryUrl: string

beforeAll(async () => {
  media = await import('../media')
  const { createDescribeImageTool } = await import('./describe-image')
  tool = createDescribeImageTool({
    sessionId: 'session1',
    text: 'what is in the photo',
    visionModel: { providerId: 'p', modelId: 'm' },
  } as never) as unknown as ToolLike

  const png = await sharp({
    create: { width: 24, height: 16, channels: 3, background: '#c81e1e' },
  })
    .png()
    .toBuffer()
  galleryUrl = await media.saveMedia(png, 'png', { source: 'user', sessionId: 'session1' })
})

beforeEach(() => {
  turnImages.length = 0
  received.imageDataUrl = undefined
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('describe_image', () => {
  it('resolves the turn attachment by number', async () => {
    turnImages.push({ url: 'data:image/png;base64,AAAA' })
    await tool.execute({ ref: 1 })
    expect(received.imageDataUrl).toBe('data:image/png;base64,AAAA')
  })

  it('resolves a gallery image by URL — the source that makes look-before count', async () => {
    await tool.execute({ ref: galleryUrl })
    expect(received.imageDataUrl).toMatch(/^data:image\/png;base64,/)

    // And they are the right bytes, not just any placeholder.
    const bytes = Buffer.from(received.imageDataUrl!.split(',')[1], 'base64')
    const meta = await sharp(bytes).metadata()
    expect(meta.width).toBe(24)
    expect(meta.height).toBe(16)
  })

  it('RASTERIZES an SVG before sending it to the vision model', async () => {
    // SVG is text, and no vision model accepts it: sending it raw returns a
    // provider error instead of a description. And looking at a vector is a frequent
    // request — checking whether the path came out good is a visual question.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><circle cx="20" cy="20" r="16" fill="#c81e1e"/></svg>`
    const url = await media.saveMedia(Buffer.from(svg, 'utf8'), 'svg', {
      source: 'chat',
      sessionId: 'session1',
    })

    await tool.execute({ ref: url })
    expect(received.imageDataUrl).toMatch(/^data:image\/png;base64,/)

    // And they are the pixels of the drawing, not an empty space.
    const bytes = Buffer.from(received.imageDataUrl!.split(',')[1], 'base64')
    const meta = await sharp(bytes).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(1024) // enlarged: the vector does not lose sharpness
  })

  it('accepts the number as text, which the model gets wrong often', async () => {
    turnImages.push({ url: 'data:image/png;base64,BBBB' })
    await tool.execute({ ref: '1' })
    expect(received.imageDataUrl).toBe('data:image/png;base64,BBBB')
  })

  it('a number outside the turn explains where to get the right ref', async () => {
    await expect(tool.execute({ ref: 3 })).rejects.toThrow(/image_list/)
  })

  it('a missing gallery ref does not become an invented description', async () => {
    await expect(tool.execute({ ref: 'orbit-media://img_naoexiste.png' })).rejects.toThrow(
      /not found/,
    )
    expect(received.imageDataUrl).toBeUndefined()
  })
})
