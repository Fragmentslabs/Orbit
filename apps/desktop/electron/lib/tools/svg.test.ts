import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The full SVG round through the gallery.
 *
 * svg-ops.test.ts covers the text manipulation. What is checked here is what
 * was missing for the format to EXIST in Orbit: being accepted, served with the right
 * type, read back and rasterized. Without that end, the agent knew how to write
 * SVG and had nothing to do with it.
 */

const userData = path.join(os.tmpdir(), `orbit-svg-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

type ToolLike = { execute: (input: Record<string, unknown>) => Promise<unknown> }

let tools: Record<string, ToolLike>
let media: typeof import('../media')

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#ff0000"/></svg>`

beforeAll(async () => {
  media = await import('../media')
  const { createSvgTools } = await import('./svg')
  tools = createSvgTools({ sessionId: 'session1' }, null) as unknown as Record<string, ToolLike>
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('svg_create', () => {
  it('becomes a real .svg file in the gallery', async () => {
    const out = (await tools.svg_create.execute({ markup: ICON, title: 'bolinha' })) as {
      mediaUrl: string
      message: string
    }
    // The mediaUrl key is what makes the chat materialize the image in the response.
    expect(out.mediaUrl).toMatch(/^orbit-media:\/\/\w+\.svg$/)

    const id = media.mediaIdFromUrl(out.mediaUrl)!
    const file = await media.readMedia(id)
    // Served as an image, which is what allows drawing it in <img> — where
    // embedded script does not run.
    expect(file!.contentType).toBe('image/svg+xml')
    expect(file!.buffer.toString('utf8')).toContain('<svg')
  })

  it('refuses markup without a viewBox — without it the SVG does not scale', async () => {
    const withoutViewBox = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`
    const out = (await tools.svg_create.execute({ markup: withoutViewBox })) as string
    expect(out).toContain('viewBox')
  })

  it('refuses script, which would travel with the downloaded file', async () => {
    const out = (await tools.svg_create.execute({
      markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>`,
    })) as string
    expect(out).toMatch(/script/i)
  })
})

describe('svg_info e svg_edit', () => {
  let url: string

  beforeAll(async () => {
    const created = (await tools.svg_create.execute({ markup: ICON, title: 'base' })) as {
      mediaUrl: string
    }
    url = created.mediaUrl
  })

  it('svg_info reports the real colors, without opening the file by hand', async () => {
    const out = (await tools.svg_info.execute({ ref: url })) as string
    expect(out).toContain('#ff0000')
    expect(out).toContain('0 0 24 24')
  })

  it('recoloring returns a new SVG, with the color swapped', async () => {
    const out = (await tools.svg_edit.execute({
      ref: url,
      recolorMap: { '#ff0000': '#2563eb' },
    })) as { mediaUrl: string; message: string }
    expect(out.message).toContain('1 paint')

    const lido = await media.readMedia(media.mediaIdFromUrl(out.mediaUrl)!)
    expect(lido!.buffer.toString('utf8')).toContain('#2563eb')
  })

  it('a map that does not match warns instead of handing back a copy as success', async () => {
    const out = (await tools.svg_edit.execute({
      ref: url,
      recolorMap: { '#00ff00': '#000000' },
    })) as { message: string }
    expect(out.message).toContain('no paint matched')
  })

  it('rasterizes sharp at the requested size — the favicon path', async () => {
    // The point of the vector: 512 from a 24 file, without upscale.
    const out = (await tools.svg_edit.execute({
      ref: url,
      width: 512,
      rasterize: 'png',
    })) as { mediaUrl: string; message: string }

    const png = await media.readMedia(media.mediaIdFromUrl(out.mediaUrl)!)
    const meta = await sharp(png!.buffer).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(512)
  })

  it('the source SVG is not changed by any edit', async () => {
    const original = await media.readMedia(media.mediaIdFromUrl(url)!)
    expect(original!.buffer.toString('utf8')).toContain('#ff0000')
  })

  it('a request with no operation does not create a silent copy', async () => {
    const out = (await tools.svg_edit.execute({ ref: url })) as string
    expect(out).toContain('No operation requested')
  })

  it('pointing at a raster explains instead of throwing', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer()
    const raster = await media.saveMedia(png, 'png', { source: 'chat', sessionId: 'session1' })
    const out = (await tools.svg_info.execute({ ref: raster })) as string
    expect(out).toContain('is not an SVG')
  })
})
