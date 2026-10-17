import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { clearResultCache, recallResult, rememberResults } from './cache'
import { MAX_IMAGE_BYTES, downloadImage, isSafeImageUrl } from './download'
import { buildContactSheet } from './sheet'
import type { Fetcher, ImageResult } from './types'

const result = (over: Partial<ImageResult> = {}): ImageResult => ({
  id: 'wc:1',
  provider: 'commons',
  title: 'Leão',
  thumbUrl: 'https://upload.wikimedia.org/t.jpg',
  downloadUrl: 'https://upload.wikimedia.org/a.jpg',
  credit: { license: 'CC BY 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:A.jpg', provider: 'commons', attribution: 'x' },
  ...over,
})

async function png(color = '#c33', size = 40): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer()
}

const reply = (body: Buffer | string, type = 'image/png', status = 200, headers: Record<string, string> = {}) =>
  new Response(body as BodyInit, { status, headers: { 'content-type': type, ...headers } })

describe('isSafeImageUrl', () => {
  it('só https público', () => {
    expect(isSafeImageUrl('https://upload.wikimedia.org/a.jpg')).toBe(true)
    expect(isSafeImageUrl('http://upload.wikimedia.org/a.jpg')).toBe(false)
    expect(isSafeImageUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeImageUrl('https://localhost/a.png')).toBe(false)
    expect(isSafeImageUrl('https://printer.local/a.png')).toBe(false)
    expect(isSafeImageUrl('https://127.0.0.1/a.png')).toBe(false)
    expect(isSafeImageUrl('https://10.0.0.5/a.png')).toBe(false)
    expect(isSafeImageUrl('https://192.168.1.2/a.png')).toBe(false)
    expect(isSafeImageUrl('https://172.20.0.1/a.png')).toBe(false)
    expect(isSafeImageUrl('https://169.254.169.254/latest')).toBe(false)
    expect(isSafeImageUrl('https://[::1]/a.png')).toBe(false)
    expect(isSafeImageUrl('https://8.8.8.8/a.png')).toBe(true)
    expect(isSafeImageUrl('nao é url')).toBe(false)
  })
})

describe('downloadImage', () => {
  it('baixa, identifica o tipo pelo servidor e devolve a extensão', async () => {
    const body = await png()
    const fetcher: Fetcher = async () => reply(body, 'image/jpeg; charset=binary')
    const out = await downloadImage(result(), fetcher)
    expect(out.ext).toBe('jpg')
    expect(out.mime).toBe('image/jpeg')
    expect(out.buffer.equals(body)).toBe(true)
  })

  it('recusa o que não é imagem raster', async () => {
    const fetcher: Fetcher = async () => reply('<html>', 'text/html')
    await expect(downloadImage(result(), fetcher)).rejects.toThrow(/not a supported image/)
    const svg: Fetcher = async () => reply('<svg/>', 'image/svg+xml')
    await expect(downloadImage(result(), svg)).rejects.toThrow(/not a supported image/)
  })

  it('recusa acima do teto, pelo cabeçalho ou lendo (cabeçalho mentiroso)', async () => {
    const declared: Fetcher = async () => reply(await png(), 'image/png', 200, { 'content-length': String(MAX_IMAGE_BYTES + 1) })
    await expect(downloadImage(result(), declared)).rejects.toThrow(/above the 25 MB limit|MB, above/)
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 10, 1)
    const lying: Fetcher = async () => reply(huge, 'image/png')
    await expect(downloadImage(result(), lying)).rejects.toThrow(/above the 25 MB limit/)
  })

  it('o endereço principal recusa (hotlink): usa o alternativo do provedor', async () => {
    const body = await png()
    const seen: string[] = []
    const fetcher: Fetcher = async (url) => {
      seen.push(url)
      return url.includes('primary') ? reply('no', 'text/plain', 403) : reply(body)
    }
    const out = await downloadImage(
      result({ downloadUrl: 'https://primary.example.com/a.png', fallbackUrl: 'https://api.openverse.org/v1/images/x/thumb/' }),
      fetcher,
    )
    expect(out.ext).toBe('png')
    expect(seen).toEqual(['https://primary.example.com/a.png', 'https://api.openverse.org/v1/images/x/thumb/'])
  })

  it('os dois falhando: o erro é o do endereço principal', async () => {
    const fetcher: Fetcher = async () => reply('no', 'text/plain', 404)
    await expect(downloadImage(result({ fallbackUrl: 'https://b.example.com/x.png' }), fetcher)).rejects.toThrow(/answered 404/)
  })

  it('endereço inseguro nem chega à rede', async () => {
    let called = false
    const fetcher: Fetcher = async () => {
      called = true
      return reply(await png())
    }
    await expect(downloadImage(result({ downloadUrl: 'http://x.com/a.png' }), fetcher)).rejects.toThrow(/unsafe/)
    expect(called).toBe(false)
  })
})

describe('cache de resultados', () => {
  it('lembra pelo id, expira e é esvaziável', () => {
    clearResultCache()
    rememberResults([result({ id: 'wc:9' })], 1000)
    expect(recallResult('wc:9', 1000 + 60_000)?.title).toBe('Leão')
    expect(recallResult(' wc:9 ', 1000 + 60_000)?.id).toBe('wc:9')
    expect(recallResult('wc:9', 1000 + 3 * 60 * 60 * 1000)).toBeNull()
    expect(recallResult('wc:404')).toBeNull()
    rememberResults([result({ id: 'wc:10' })])
    clearResultCache()
    expect(recallResult('wc:10')).toBeNull()
  })

  it('o mais antigo sai quando passa do limite', () => {
    clearResultCache()
    rememberResults(Array.from({ length: 650 }, (_, i) => result({ id: `wc:${i}` })))
    expect(recallResult('wc:0')).toBeNull()
    expect(recallResult('wc:649')).not.toBeNull()
    clearResultCache()
  })
})

describe('buildContactSheet', () => {
  it('monta uma folha com uma célula por resultado (e segue sem a miniatura que falhou)', async () => {
    const thumb = await png('#36c', 200)
    const fetcher: Fetcher = async (url) => (url.includes('broken') ? reply('x', 'text/plain', 500) : reply(thumb))
    const sheet = await buildContactSheet(
      [result({ thumbUrl: 'https://a/1.png' }), result({ id: 'wc:2', thumbUrl: 'https://a/broken.png' }), result({ id: 'wc:3', thumbUrl: 'https://a/3.png' })],
      fetcher,
    )
    const meta = await sharp(sheet!).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(320 * 4)
    expect(meta.height).toBe(220)
  })

  it('várias linhas quando passa de quatro; nenhuma miniatura legível = sem folha', async () => {
    const thumb = await png('#3a6', 200)
    const ok: Fetcher = async () => reply(thumb)
    const sheet = await buildContactSheet(Array.from({ length: 6 }, (_, i) => result({ id: `wc:${i}` })), ok)
    expect((await sharp(sheet!).metadata()).height).toBe(220 * 2)

    const bad: Fetcher = async () => reply('x', 'text/plain', 500)
    expect(await buildContactSheet([result()], bad)).toBeNull()
  })

  it('limita a oito células', async () => {
    const thumb = await png('#a63', 200)
    const sheet = await buildContactSheet(Array.from({ length: 12 }, (_, i) => result({ id: `wc:${i}` })), async () => reply(thumb))
    expect((await sharp(sheet!).metadata()).height).toBe(220 * 2)
  })
})
