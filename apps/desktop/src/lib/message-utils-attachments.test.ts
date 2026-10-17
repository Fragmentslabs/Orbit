import { describe, expect, it } from 'vitest'
import { blobUrlsToDataUrls, isLargeMediaType, pathToFileUrl, rememberAttachmentPath } from './message-utils'

describe('pathToFileUrl', () => {
  it('monta um file:// que o main desfaz com fileURLToPath', () => {
    expect(pathToFileUrl('/Users/a b/Meu Vídeo #1.mp4')).toBe('file:///Users/a%20b/Meu%20V%C3%ADdeo%20%231.mp4')
    expect(pathToFileUrl('/tmp/x?.mp4')).toBe('file:///tmp/x%3F.mp4')
  })

  it('caminho do Windows', () => {
    expect(pathToFileUrl('C:\\Users\\a\\clip.mp4')).toBe('file:///C:/Users/a/clip.mp4')
  })
})

describe('isLargeMediaType', () => {
  it('vídeo pelo MIME ou pela extensão; o resto não', () => {
    expect(isLargeMediaType('video/mp4')).toBe(true)
    expect(isLargeMediaType('', 'clip.MOV')).toBe(true)
    expect(isLargeMediaType('image/png', 'a.png')).toBe(false)
    expect(isLargeMediaType('audio/mpeg', 'a.mp3')).toBe(false)
  })
})

describe('blobUrlsToDataUrls com caminho', () => {
  it('um vídeo de arquivo vira o file:// do caminho — sem ler o blob', async () => {
    rememberAttachmentPath('blob:video-1', '/Users/a/clip.mp4')
    const [item] = await blobUrlsToDataUrls([{ url: 'blob:video-1', mediaType: 'video/mp4', filename: 'clip.mp4' }])
    expect(item.url).toBe('file:///Users/a/clip.mp4')
  })

  it('o caminho é consumido uma vez', async () => {
    rememberAttachmentPath('blob:video-2', '/Users/a/b.mp4')
    await blobUrlsToDataUrls([{ url: 'blob:video-2', mediaType: 'video/mp4' }])
    // Sem caminho e sem como ler o blob (não há fetch de blob em Node): fica como veio.
    const [again] = await blobUrlsToDataUrls([{ url: 'blob:video-2', mediaType: 'video/mp4' }])
    expect(again.url).toBe('blob:video-2')
  })

  it('o que não é blob passa direto', async () => {
    const [item] = await blobUrlsToDataUrls([{ url: 'data:text/plain;base64,QQ==', mediaType: 'text/plain' }])
    expect(item.url).toBe('data:text/plain;base64,QQ==')
  })
})
