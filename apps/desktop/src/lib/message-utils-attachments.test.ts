import { describe, expect, it } from 'vitest'
import { blobUrlsToDataUrls, isLargeMediaType, pathToFileUrl, rememberAttachmentPath } from './message-utils'

describe('pathToFileUrl', () => {
  it('builds a file:// that main undoes with fileURLToPath', () => {
    expect(pathToFileUrl('/Users/a b/Meu Vídeo #1.mp4')).toBe('file:///Users/a%20b/Meu%20V%C3%ADdeo%20%231.mp4')
    expect(pathToFileUrl('/tmp/x?.mp4')).toBe('file:///tmp/x%3F.mp4')
  })

  it('Windows path', () => {
    expect(pathToFileUrl('C:\\Users\\a\\clip.mp4')).toBe('file:///C:/Users/a/clip.mp4')
  })
})

describe('isLargeMediaType', () => {
  it('video by MIME or by extension; the rest does not', () => {
    expect(isLargeMediaType('video/mp4')).toBe(true)
    expect(isLargeMediaType('', 'clip.MOV')).toBe(true)
    expect(isLargeMediaType('image/png', 'a.png')).toBe(false)
    expect(isLargeMediaType('audio/mpeg', 'a.mp3')).toBe(false)
  })
})

describe('blobUrlsToDataUrls with a path', () => {
  it("a file video becomes the file:// of the path — without reading the blob", async () => {
    rememberAttachmentPath('blob:video-1', '/Users/a/clip.mp4')
    const [item] = await blobUrlsToDataUrls([{ url: 'blob:video-1', mediaType: 'video/mp4', filename: 'clip.mp4' }])
    expect(item.url).toBe('file:///Users/a/clip.mp4')
  })

  it('the path is consumed once', async () => {
    rememberAttachmentPath('blob:video-2', '/Users/a/b.mp4')
    await blobUrlsToDataUrls([{ url: 'blob:video-2', mediaType: 'video/mp4' }])
    // Without a path and without a way to read the blob (there is no blob fetch in Node): it stays as it came.
    const [again] = await blobUrlsToDataUrls([{ url: 'blob:video-2', mediaType: 'video/mp4' }])
    expect(again.url).toBe('blob:video-2')
  })

  it('whatever is not a blob passes through', async () => {
    const [item] = await blobUrlsToDataUrls([{ url: 'data:text/plain;base64,QQ==', mediaType: 'text/plain' }])
    expect(item.url).toBe('data:text/plain;base64,QQ==')
  })
})
