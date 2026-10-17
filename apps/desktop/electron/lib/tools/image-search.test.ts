import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * image_search + image_import de ponta a ponta, com as respostas REAIS das APIs
 * gravadas e uma rede falsa: o resultado vira uma imagem do app com o crédito, que
 * o motion_asset leva até a peça.
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

/** image_import devolve { message, images }: o texto é para o modelo, as imagens vão para a resposta. */
type Imported = { message: string; images: Array<{ mediaUrl: string; alt: string }> }
const importIds = async (tools: Record<string, unknown>, ids: string[]) => (await call(tools, 'image_import', { ids })) as Imported | string

/** A rede falsa: as duas APIs, miniaturas e os arquivos das imagens. */
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
  it('lista os candidatos com id, licença e tamanho — e já filtra o que a licença comercial não permite', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    const out = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    expect(out).toMatch(/^5 candidate\(s\) for "lion"/)
    expect(out).toMatch(/1\. wc:\d+ — "Lion \(Panthera leo\)/)
    expect(out).toContain('CC BY-SA 4.0')
    expect(out).toContain('Openverse via flickr')
    expect(out).not.toContain('NC-ND')
    // Sem visão, diz que a escolha é pelo título.
    expect(out).toContain('You cannot see the thumbnails')
  })

  it('com visão, a folha de miniaturas segue junto, como imagem', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: true })
    await call(tools, 'image_search', { query: 'lion', minWidth: 500 }, 'sheet1')
    const toModel = (tools.image_search as unknown as { toModelOutput: Output }).toModelOutput
    const modelOutput = toModel({ toolCallId: 'sheet1', output: 'texto' }) as { type: string; value: Array<{ type: string; mediaType?: string }> }
    expect(modelOutput.type).toBe('content')
    expect(modelOutput.value.map((v) => v.type)).toEqual(['text', 'image-data'])
    expect(modelOutput.value[1].mediaType).toBe('image/webp')
    // A folha é consumida uma vez: a segunda leitura volta só ao texto.
    expect(toModel({ toolCallId: 'sheet1', output: 'texto' })).toEqual({ type: 'text', value: 'texto' })
  })

  it('sem resultados, diz o que tentar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })))
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    const out = String(await call(tools, 'image_search', { query: 'zzzz' }))
    expect(out).toMatch(/No images found/)
    expect(out).toContain('Try other words')
  })

  it('o aviso de um provedor limitado aparece, sem esconder os resultados do outro', async () => {
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
  it('traz a escolhida para o app como imagem com autor e licença, e devolve a linha de crédito', async () => {
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

  it('o crédito acompanha a imagem até a peça: motion_asset o exige no relatório', async () => {
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

  it('id que não está na última busca: pede para buscar de novo', async () => {
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    expect(((await importIds(tools, ['wc:404'])) as Imported).message).toContain('not in the last search results')
  })

  it('o download recusado não derruba os outros; o erro vem com o motivo', async () => {
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

  it('um arquivo que o servidor chama de imagem mas não decodifica é recusado', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.startsWith('https://commons.wikimedia.org')) return new Response(commonsJson, { headers: { 'content-type': 'application/json' } })
        if (u.startsWith('https://api.openverse.org')) return new Response('{}', { headers: { 'content-type': 'application/json' } })
        return new Response('isto não é uma imagem', { headers: { 'content-type': 'image/jpeg' } })
      }),
    )
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    const search = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    const out = ((await importIds(tools, [/(wc:\d+)/.exec(search)![1]])) as Imported).message
    expect(out).toContain('could not be imported')
  })
})

describe('as imagens aparecem na resposta', () => {
  it('image_import devolve as imagens para o chat-engine mostrar, e diz ao modelo para não reincorporar', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's5', modelVision: false })
    const search = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    const ids = [...search.matchAll(/\d+\. (wc:\d+)/g)].slice(0, 2).map((m) => m[1])
    const out = (await importIds(tools, ids)) as Imported

    expect(out.images).toHaveLength(2)
    for (const image of out.images) {
      expect(image.mediaUrl).toMatch(/^orbit-media:\/\/img_[a-z0-9]+\.jpg$/)
      expect(image.alt).toMatch(/^Lion/)
      // Cada uma é um item do app, que o "abrir no chat" e a galeria enxergam.
      expect(await media.getMediaEntry(image.mediaUrl.replace('orbit-media://', ''))).not.toBeNull()
    }
    expect(out.message).toContain('already appear in your reply')
    expect(out.message).toContain('do NOT embed them again with markdown')
  })

  it('o modelo recebe só o relatório em texto (as imagens não entram no contexto dele)', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's5', modelVision: false })
    const toModel = (tools.image_import as unknown as { toModelOutput: Output }).toModelOutput
    const result = toModel({ toolCallId: 'x', output: { message: 'relatório', images: [{ mediaUrl: 'orbit-media://img_a.jpg', alt: '' }] } })
    expect(result).toEqual({ type: 'text', value: 'relatório' })
  })

  it('nada importado: lista vazia e a mensagem diz isso', async () => {
    const tools = createImageSearchTools({ sessionId: 's5', modelVision: false })
    const out = (await importIds(tools, ['wc:404'])) as Imported
    expect(out.images).toEqual([])
    expect(out.message).toContain('Nothing was imported')
  })
})

describe('show_image no modo chat', () => {
  it('mostra uma imagem do app na resposta, pelo ref ou pela URL', async () => {
    installNetwork()
    const search = createImageSearchTools({ sessionId: 's6', modelVision: false })
    const found = String(await call(search, 'image_search', { query: 'lion', minWidth: 500 }))
    const imported = (await importIds(search, [/(wc:\d+)/.exec(found)![1]])) as Imported
    const ref = imported.images[0].mediaUrl.replace('orbit-media://', '')

    const show = createGalleryShowImageTool()
    expect(await call(show, 'show_image', { media: ref, alt: 'um leão' })).toMatchObject({ mediaUrl: `orbit-media://${ref}`, alt: 'um leão' })
    expect(await call(show, 'show_image', { media: `orbit-media://${ref}` })).toMatchObject({ mediaUrl: `orbit-media://${ref}` })
  })

  it('referência inválida ou inexistente volta como texto, sem derrubar', async () => {
    const show = createGalleryShowImageTool()
    expect(String(await call(show, 'show_image', { media: 'https://example.com/a.png' }))).toContain('Invalid media reference')
    expect(String(await call(show, 'show_image', { media: 'img_naoexiste.png' }))).toContain('not found')
  })
})
