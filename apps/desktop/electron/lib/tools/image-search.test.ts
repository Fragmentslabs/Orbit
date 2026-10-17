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

const { createImageSearchTools } = await import('./image-search')
const { clearResultCache } = await import('../image-search/cache')
const media = await import('../media')
const { importAttachmentInto } = await import('../video/motion-asset')
const { resolveAttachmentRef } = await import('../attachment-ref')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
type Output = (args: { toolCallId: string; output: unknown }) => { type: string; value: unknown }
const call = async (tools: Record<string, unknown>, name: string, input: unknown, id = 'c1') =>
  (tools[name] as { execute: Exec }).execute(input, { toolCallId: id, messages: [], abortSignal: undefined })

let photo: Buffer

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

    const out = String(await call(tools, 'image_import', { ids: [id] }))
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
    const imported0 = String(await call(tools, 'image_import', { ids: [id] }))
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
    expect(String(await call(tools, 'image_import', { ids: ['wc:404'] }))).toContain('not in the last search results')
  })

  it('o download recusado não derruba os outros; o erro vem com o motivo', async () => {
    installNetwork()
    const tools = createImageSearchTools({ sessionId: 's1', modelVision: false })
    await call(tools, 'image_search', { query: 'lion', minWidth: 500 })
    installNetwork({ failDownload: true })
    const search = String(await call(tools, 'image_search', { query: 'lion', minWidth: 500 }))
    const id = /\d+\. (wc:\d+)/.exec(search)![1]
    const out = String(await call(tools, 'image_import', { ids: [id] }))
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
    const out = String(await call(tools, 'image_import', { ids: [/(wc:\d+)/.exec(search)![1]] }))
    expect(out).toContain('could not be imported')
  })
})
