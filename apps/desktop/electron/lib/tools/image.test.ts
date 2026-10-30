import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The full round of image editing: finding the reference, editing through it and
 * returning something the chat can SHOW.
 *
 * image-ops.test.ts covers the processing; what is checked here is the
 * link with the gallery, which is where the photo the user attached lives — without
 * it the operations would exist with nothing to operate on.
 */

const userData = path.join(os.tmpdir(), `orbit-image-test-${process.pid}`)

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

beforeAll(async () => {
  media = await import('../media')
  const { createImageTools } = await import('./image')
  // ctx null = chat mode: the only source is the gallery, which is the case of the user
  // who dragged a photo into the conversation.
  tools = createImageTools({ sessionId: 'session1' }, null) as unknown as Record<string, ToolLike>
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

/** A red subject on a white background, like a product photo. */
async function productShot(): Promise<Buffer> {
  return sharp({ create: { width: 80, height: 80, channels: 3, background: '#ffffff' } })
    .composite([
      {
        input: await sharp({
          create: { width: 30, height: 30, channels: 3, background: '#c81e1e' },
        })
          .png()
          .toBuffer(),
        top: 25,
        left: 25,
      },
    ])
    .png()
    .toBuffer()
}

describe('tools de imagem', () => {
  it('image_list finds the attached image and returns its ref', async () => {
    await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session1',
      name: 'product.png',
    })
    const listed = (await tools.image_list.execute({})) as string
    expect(listed).toContain('product.png')
    expect(listed).toContain('attached by the user')
    expect(listed).toMatch(/orbit-media:\/\/img_\w+\.png/)
  })

  it('does not take another conversation image for this one', async () => {
    await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'other-session',
      name: 'from-other-chat.png',
    })
    expect((await tools.image_list.execute({})) as string).not.toContain('from-other-chat.png')
  })

  it('image_info reads through the gallery ref', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session1',
      name: 'size.png',
    })
    const info = (await tools.image_info.execute({ ref: url })) as string
    expect(info).toContain('80x80')
    expect(info).toContain('png')
  })

  it('image_edit returns the format the chat can render', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session1',
      name: 'shrink.png',
    })
    const result = (await tools.image_edit.execute({ ref: url, resize: { width: 40 } })) as {
      mediaUrl: string
      message: string
    }
    // chat-engine materializes the ImagePart from mediaUrl: without that
    // key the user would only read about the edit instead of seeing it.
    expect(result.mediaUrl).toMatch(/^orbit-media:\/\//)
    expect(result.message).toContain('40x40')

    // And the result enters the gallery, which allows chaining another edit.
    const saved = await media.readMedia(media.mediaIdFromUrl(result.mediaUrl)!)
    expect((await sharp(saved!.buffer).metadata()).width).toBe(40)
  })

  it('image_edit reports how much of the background was removed', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session1',
      name: 'fundo.png',
    })
    const result = (await tools.image_edit.execute({
      ref: url,
      removeBackground: {},
    })) as { message: string }
    expect(result.message).toMatch(/background #ffffff removed from 8\d%/)
  })

  it('warns when the background cut caught nothing instead of delivering silently', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session1',
      name: 'wrong.png',
    })
    const result = (await tools.image_edit.execute({
      ref: url,
      removeBackground: { color: '#00ff00', tolerance: 0 },
    })) as { message: string }
    expect(result.message).toContain('almost nothing was removed')
  })

  it('the original stays intact in the gallery after the edit', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session1',
      name: 'intact.png',
    })
    await tools.image_edit.execute({ ref: url, resize: { width: 20 } })
    const original = await media.readMedia(media.mediaIdFromUrl(url)!)
    expect((await sharp(original!.buffer).metadata()).width).toBe(80)
  })

  it('a missing ref explains the problem instead of throwing', async () => {
    const out = (await tools.image_edit.execute({
      ref: 'orbit-media://img_naoexiste.png',
      resize: { width: 10 },
    })) as string
    expect(out).toContain('not found')
  })

  it('a request with no operation does not create a silent copy', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session1',
      name: 'vazia.png',
    })
    const out = (await tools.image_edit.execute({ ref: url })) as string
    expect(out).toContain('No operation requested')
  })

  it('in chat, a file path does not become a disk read', async () => {
    // With no working folder there is nothing to resolve, and accepting the path would be
    // reading any file on the machine from a text of the model.
    const out = (await tools.image_info.execute({ ref: '../../etc/passwd.png' })) as string
    expect(out).toContain('Image not found')
  })
})

describe('image_delete', () => {
  it('deletes an agent image from a previous turn (without the turn hooks)', async () => {
    // Retroactive cleanup is the case that matters most: the gallery has already filled with
    // steps from an old conversation and the user asks to tidy it up. Before this
    // was impossible — the lock looked at the turn instead of the origin.
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'chat',
      sessionId: 'session1',
      name: 'yesterday-step.png',
    })
    const out = (await tools.image_delete.execute({ refs: [url] })) as string
    expect(out).toContain('deleted')
    expect(await media.getMediaEntry(media.mediaIdFromUrl(url)!)).toBeNull()
  })

  it('deletes an image generated in this same reply and drops it from the file', async () => {
    const { createImageTools } = await import('./image')
    const turnMediaUrls = new Set<string>()
    const removeImageParts = vi.fn()
    const hookedTools = createImageTools({ sessionId: 'session2' }, null, {
      turnMediaUrls,
      removeImageParts,
      noteDerived: vi.fn(),
    }) as unknown as Record<string, ToolLike>

    const original = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session2',
      name: 'draft-base.png',
    })
    const edited = (await hookedTools.image_edit.execute({
      ref: original,
      resize: { width: 40 },
    })) as { mediaUrl: string }
    // chat-engine registers the image in turnMediaUrls as soon as it enters the
    // response — here we simulate that step.
    turnMediaUrls.add(edited.mediaUrl)

    const out = (await hookedTools.image_delete.execute({ refs: [edited.mediaUrl] })) as string
    expect(out).toContain('deleted')
    expect(removeImageParts).toHaveBeenCalledWith([edited.mediaUrl])
    expect(await media.getMediaEntry(media.mediaIdFromUrl(edited.mediaUrl)!)).toBeNull()
  })

  it('never deletes what the user attached, not even in the same turn', async () => {
    const { createImageTools } = await import('./image')
    const turnMediaUrls = new Set<string>()
    const removeImageParts = vi.fn()
    const hookedTools = createImageTools({ sessionId: 'session3' }, null, {
      turnMediaUrls,
      removeImageParts,
      noteDerived: vi.fn(),
    }) as unknown as Record<string, ToolLike>

    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session3',
      name: 'user-attachment.png',
    })
    // Even listed as a turn image, the user's photo belongs to them.
    turnMediaUrls.add(url)

    const out = (await hookedTools.image_delete.execute({ refs: [url] })) as string
    expect(out).toContain('user attachment')
    expect(removeImageParts).not.toHaveBeenCalled()
    expect(await media.getMediaEntry(media.mediaIdFromUrl(url)!)).not.toBeNull()
  })

  it('refuses to delete an image from another conversation', async () => {
    const { createImageTools } = await import('./image')
    const outrosTools = createImageTools({ sessionId: 'current-session' }, null, {
      turnMediaUrls: new Set<string>(),
      removeImageParts: vi.fn(),
      noteDerived: vi.fn(),
    }) as unknown as Record<string, ToolLike>

    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'chat',
      sessionId: 'other-session',
      name: 'from-other-chat.png',
    })
    const out = (await outrosTools.image_delete.execute({ refs: [url] })) as string
    expect(out).toContain('another conversation')
    expect(await media.getMediaEntry(media.mediaIdFromUrl(url)!)).not.toBeNull()
  })

  it('the edit records which image it came from and notifies the runtime', async () => {
    const { createImageTools } = await import('./image')
    const noteDerived = vi.fn()
    const hookedTools = createImageTools({ sessionId: 'session4' }, null, {
      turnMediaUrls: new Set<string>(),
      removeImageParts: vi.fn(),
      noteDerived,
    }) as unknown as Record<string, ToolLike>

    const original = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'session4',
      name: 'base.png',
    })
    const edited = (await hookedTools.image_edit.execute({
      ref: original,
      resize: { width: 40 },
    })) as { mediaUrl: string }

    // Without the parentId the gallery has no way to stack the versions, and without the notice
    // to the runtime the step would never be folded at the end of the turn.
    const entry = await media.getMediaEntry(media.mediaIdFromUrl(edited.mediaUrl)!)
    expect(entry?.parentId).toBe(media.mediaIdFromUrl(original))
    expect(noteDerived).toHaveBeenCalledWith(edited.mediaUrl, original, false)
  })
})

describe('editing an image searched on the web keeps the credit', () => {
  it('cropping or writing over is adapting: the license still requires the author', async () => {
    const credit = {
      title: 'Leão',
      creator: 'Ana',
      license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Leao.jpg',
      provider: 'commons' as const,
      attribution: '"Leão" by Ana, licensed under CC BY 4.0',
    }
    const url = await media.saveMedia(await productShot(), 'png', { source: 'chat', sessionId: 'session1', name: 'Lion', credit })
    const id = media.mediaIdFromUrl(url)!

    const edited = (await tools.image_edit.execute({ ref: url, resize: { width: 40 } })) as { mediaUrl: string }
    const entry = await media.getMediaEntry(media.mediaIdFromUrl(edited.mediaUrl)!)

    expect(entry?.parentId).toBe(id)
    expect(entry?.credit).toEqual(credit)
  })

  it('an image without credit (user attachment) stays without', async () => {
    const url = await media.saveMedia(await productShot(), 'png', { source: 'user', sessionId: 'session1', name: 'foto' })
    const edited = (await tools.image_edit.execute({ ref: url, resize: { width: 40 } })) as { mediaUrl: string }
    expect((await media.getMediaEntry(media.mediaIdFromUrl(edited.mediaUrl)!))?.credit).toBeUndefined()
  })
})
