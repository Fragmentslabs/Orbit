import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * image_search + image_import end to end, with the APIs' REAL responses
 * recorded and a fake network: the result becomes an app image with the credit, which
 * motion_asset carries into the piece.
 */

const userData = path.join(os.tmpdir(), `orbit-image-search-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const fixtures = path.join(__dirname, '..', 'image-search', 'fixtures')
const commonsJson = fs.readFileSync(path.join(fixtures, 'commons.json'), 'utf8')
const openverseJson = fs.readFileSync(path.join(fixtures, 'openverse.json'), 'utf8')

const { createGalleryShowImageTool, createImageSearchTools } = await import('./image-search')
const { clearResultCache } = await import('../image-search/cache')
const media = await import('../media')
const { importAttachmentInto } = await import('../video/motion-asset')
const { resolveAttachmentRef } = await import('../attachment-ref')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
type Output = (args: { toolCallId: string; output: unknown }) => { type: string; value: unknown }
const call = async (tools: Record<string, unknown>, name: string, input: unknown, id = 'c1') =>
  (tools[name] as { execute: Exec }).execute(input, { toolCallId: id, messages: [], abortSignal: undefined })

let photo: Buffer

/** image_import returns { message, images }: the text is for the model, the images go to the response. */
type Imported = { message: string; images: Array<{ mediaUrl: string; alt: string }> }
const importIds = async (tools: Record<string, unknown>, ids: string[]) => (await call(tools, 'image_import', { ids })) as Imported | string

/** The fake network: both APIs, thumbnails and the image files. */
function installNetwork(opts: { failDownload?: boolean } = {}): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      urls.push(String(input))
      const url = String(input)
      if (url.startsWith('https://commons.wikimedia.org/w/api.php')) return new Response(commonsJson, { headers: { 'content-type': 'application/json' } })
      if (url.startsWith('https://api.openverse.org/v1/images/?')) return new Response(openverseJson, { headers: { 'content-type': 'application/json' } })
      if (opts.failDownload) return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } })
      return new Response(photo as BodyInit, { headers: { 'content-type': 'image/jpeg' } })
    }),
  )
  return urls
}

beforeAll(async () => {
  await fsp.mkdir(userData, { recursive: true })
  photo = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#d8a24a' } }).jpeg().toBuffer()
})
afterEach(() => {
  vi.unstubAllGlobals()
  clearResultCache()
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('image_search', () => {
  it('lists the candidates with id, license and size — and already filters what the commercial license does not allow', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    const out = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    expect(out).toMatch(/^5 candidate\(s\) for "lion"/)
    expect(out).toMatch(/1\. wc:\d+ — "Lion \(Panthera leo\)/)
    expect(out).toContain('CC BY-SA 4.0')
    expect(out).toContain('Openverse via flickr')
    expect(out).not.toContain('NC-ND')
    // Without vision, it says the choice is by title.
    expect(out).toContain('You cannot see the thumbnails')
  })

  it('with vision, the thumbnail sheet comes along, as an image', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: true })
    await call(tools, 'image_search', { query: 'lion', minWidth: 500 }, 'sheet1')
    const toModel = (tools.image_search as unknown as { toModelOutput: Output }).toModelOutput
    const modelOutput = toModel({ toolCallId: 'sheet1', output: 'text' }) as { type: string; value: Array<{ type: string; mediaType?: string }> }
    expect(modelOutput.type).toBe('content')
    expect(modelOutput.value.map((v) => v.type)).toEqual(['text', 'image-data'])
    expect(modelOutput.value[1].mediaType).toBe('image/webp')
    // The sheet is consumed once: the second read returns only the text.
    expect(toModel({ toolCallId: 'sheet1', output: 'text' })).toEqual({ type: 'text', value: 'text' })
  })

  it('with no results, says what to try', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })))
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    const out = String(await call(tools, 'image_search', { query: 'zzzz' }))
    expect(out).toMatch(/No images found/)
    expect(out).toContain('Try other words')
  })

  it('a limited provider warning shows up without hiding the other\'s results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('openverse') ? new Response('{}', { status: 429 }) : new Response(commonsJson, { headers: { 'content-type': 'application/json' } }),
      ),
    )
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    const out = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    expect(out).toContain('Warning: Openverse: rate limit reached')
    expect(out).toMatch(/candidate\(s\)/)
  })
})

describe('image_import', () => {
  it('brings the chosen one into the app as an image with author and license, and returns the credit line', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    const search = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    const id = /\d+\. (wc:\d+)/.exec(search)![1]

    const imported = (await importIds(tools, [id])) as Imported
    const out = imported.message
    const ref = /ref (img_[a-z0-9]+\.jpg)/.exec(out)![1]
    expect(out).toContain('1600x900')
    expect(out).toContain('CC BY-SA 4.0')
    expect(out).toMatch(/Credit: "Lion \(Panthera leo\)[^"]*" by .+, licensed under CC BY-SA 4\.0/)

    const entry = await media.getMediaEntry(ref)
    expect(entry).toMatchObject({ kind: 'image', source: 'chat', sessionId: 's1' })
    expect(entry?.credit).toMatchObject({ license: 'CC BY-SA 4.0', provider: 'commons' })
    expect(entry?.credit?.sourceUrl).toMatch(/commons\.wikimedia\.org\/wiki\/File:/)
  })

  it('the credit follows the image into the piece: motion_asset requires it in the report', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's2', modelVision: false })
    const search = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500, provider: 'openverse' }))
    const id = /ov:[0-9a-f-]{36}/.exec(search)![0]
    const imported0 = ((await importIds(tools, [id])) as Imported).message
    const ref = /ref (img_[a-z0-9]+\.[a-z]+)/.exec(imported0)![1]
    expect((await resolveAttachmentRef(ref))?.credit?.license).toMatch(/^CC0/)

    const piece = path.join(userData, 'piece')
    const imported = await importAttachmentInto(piece, ref)
    expect(imported.report).toContain('CREDIT REQUIRED by the license (CC0 1.0)')
    expect(imported.report).toContain('credits card')
    expect(fs.existsSync(path.join(piece, imported.name))).toBe(true)
  })

  it('an id that is not in the last search: asks to search again', async () => {
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    expect(((await importIds(tools, ['wc:404'])) as Imported).message).toContain('not in the last search results')
  })

  it('a refused download does not take the others down; the error comes with the reason', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    await call(tools, 'image_search', { query: 'lion', minWidth: 500 })
    installNetwork({ failDownload: true })
    const search = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    const id = /\d+\. (wc:\d+)/.exec(search)![1]
    const out = ((await importIds(tools, [id])) as Imported).message
    expect(out).toContain('could not be imported')
    expect(out).toContain('answered 403')
  })

  it('a file the server calls an image but that does not decode is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.startsWith('https://commons.wikimedia.org')) return new Response(commonsJson, { headers: { 'content-type': 'application/json' } })
        if (u.startsWith('https://api.openverse.org')) return new Response('{}', { headers: { 'content-type': 'application/json' } })
        return new Response('this is not an image', { headers: { 'content-type': 'image/jpeg' } })
      }),
    )
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    const search = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    const out = ((await importIds(tools, [/(wc:\d+)/.exec(search)![1]])) as Imported).message
    expect(out).toContain('could not be imported')
  })
})

describe('the images show up in the reply', () => {
  it('image_import returns the images for the chat-engine to show, and tells the model not to re-embed them', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's5', modelVision: false })
    const search = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    const ids = [...search.matchAll(/\d+\. (wc:\d+)/g)].slice(0, 2).map((m) => m[1])
    const out = (await importIds(tools, ids)) as Imported

    expect(out.images).toHaveLength(2)
    for (const image of out.images) {
      expect(image.mediaUrl).toMatch(/^orbit-media:\/\/img_[a-z0-9]+\.jpg$/)
      expect(image.alt).toMatch(/^Lion/)
      // Each one is an app item, which "open in chat" and the gallery can see.
      expect(await media.getMediaEntry(image.mediaUrl.replace('orbit-media://', ''))).not.toBeNull()
    }
    expect(out.message).toContain('already appear in your reply')
    expect(out.message).toContain('do NOT embed them again with markdown')
  })

  it('the model gets only the text report (the images do not enter its context)', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's5', modelVision: false })
    const toModel = (tools.image_import as unknown as { toModelOutput: Output }).toModelOutput
    const result = toModel({ toolCallId: 'x', output: { message: 'relatório', images: [{ mediaUrl: 'orbit-media://img_a.jpg', alt: '' }] } })
    expect(result).toEqual({ type: 'text', value: 'relatório' })
  })

  it('nothing imported: empty list and the message says so', async () => {
    const tools = createImageSearchTools({ sessionId: 's5', modelVision: false })
    const out = (await importIds(tools, ['wc:404'])) as Imported
    expect(out.images).toEqual([])
    expect(out.message).toContain('Nothing was imported')
  })
})

describe('show_image in chat mode', () => {
  it('shows an app image in the reply, by ref or by URL', async () => {
    installNetwork()
    const search = createImageSearchTools({ sessionId: 's6', modelVision: false })
    const found = String(await call(search, 'image_search', { query: 'lion', minWidth: 500 }))
    const imported = (await importIds(search, [/(wc:\d+)/.exec(found)![1]])) as Imported
    const ref = imported.images[0].mediaUrl.replace('orbit-media://', '')

    const show = createGalleryShowImageTool()
    expect(await call(show, 'show_image', { media: ref, alt: 'a lion' })).toMatchObject({ mediaUrl: `orbit-media://${ref}`, alt: 'a lion' })
    expect(await call(show, 'show_image', { media: `orbit-media://${ref}` })).toMatchObject({ mediaUrl: `orbit-media://${ref}` })
  })

  it('an invalid or missing ref comes back as text, without breaking', async () => {
    const show = createGalleryShowImageTool()
    expect(String(await call(show, 'show_image', { media: 'https://example.com/a.png' }))).toContain('Invalid media reference')
    expect(String(await call(show, 'show_image', { media: 'img_naoexiste.png' }))).toContain('not found')
  })
})
