import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const work = path.join(os.tmpdir(), `orbit-attachments-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work },
  protocol: {},
}))

const mediaEntries: Record<string, { id: string; path: string; name?: string }> = {}
vi.mock('./media', () => ({
  SAFE_AUDIO_ID: /^aud_[a-z0-9]+\.(wav|mp3)$/,
  audioMediaId: (value: string) => (/^aud_[a-z0-9]+\.(wav|mp3)$/.test(value.trim()) ? value.trim() : null),
  mediaIdFromUrl: (value: string) => {
    const id = value.replace('orbit-media://', '')
    return /^img_[a-z0-9]+\.(png|gif)$/.test(id) ? id : null
  },
  getMediaEntry: async (id: string) => mediaEntries[id] ?? null,
  registerAudioMedia: async () => {},
}))

const {
  MAX_VIDEO_ATTACHMENT_BYTES,
  isVideoFile,
  looksLikeAttachmentRef,
  resolveAttachmentRef,
  saveVideoAttachment,
  videoAttachmentDir,
  videoAttachmentExt,
  videoPathFromFileUrl,
} = await import('./attachment-ref')

beforeAll(async () => {
  await fsp.mkdir(work, { recursive: true })
})
afterAll(async () => {
  await fsp.rm(work, { recursive: true, force: true })
})

describe('tipo do anexo', () => {
  it('vídeo pelo MIME ou pela extensão', () => {
    expect(isVideoFile('video/mp4')).toBe(true)
    expect(isVideoFile('', 'Aula.MOV')).toBe(true)
    expect(isVideoFile('audio/mpeg', 'a.mp3')).toBe(false)
    expect(isVideoFile('image/gif', 'a.gif')).toBe(false)
  })

  it('extensão guardada: MIME primeiro, nome depois, senão recusa', () => {
    expect(videoAttachmentExt('video/quicktime')).toBe('mov')
    expect(videoAttachmentExt('', 'clip.WEBM')).toBe('webm')
    expect(videoAttachmentExt('video/x-unknown', 'clip')).toBeNull()
  })
})

describe('looksLikeAttachmentRef', () => {
  it('reconhece as três famílias, com ou sem "ref " e URL; um caminho do projeto não é referência', () => {
    for (const ref of ['vdo_abc123.mp4', 'ref aud_abc.wav', 'orbit-media://img_ab1.png', 'orbit-audio://aud_x1.mp3']) {
      expect(looksLikeAttachmentRef(ref), ref).toBe(true)
    }
    for (const ref of ['edit/clip.mp4', '/Users/a/vdo_x.mp4', 'video.mp4', '']) {
      expect(looksLikeAttachmentRef(ref), ref).toBe(false)
    }
  })
})

describe('saveVideoAttachment', () => {
  it('guarda bytes e devolve uma referência resolvível, com o nome original', async () => {
    const saved = await saveVideoAttachment({ bytes: Buffer.from('fake') }, 'mp4', { name: 'Minha Aula.mp4', sessionId: 's1' })
    expect(saved.id).toMatch(/^vdo_[a-z0-9]+\.mp4$/)
    expect(saved.file).toBe(path.join(videoAttachmentDir(), saved.id))
    const resolved = await resolveAttachmentRef(saved.id)
    expect(resolved).toMatchObject({ kind: 'video', id: saved.id, file: saved.file, name: 'Minha Aula.mp4' })
  })

  it('copia de um arquivo do disco (o caminho do arrastar/escolher)', async () => {
    const source = path.join(work, 'original.mov')
    await fsp.writeFile(source, 'movie-bytes')
    const saved = await saveVideoAttachment({ copyFrom: source }, 'mov', { name: 'original.mov' })
    expect(await fsp.readFile(saved.file, 'utf8')).toBe('movie-bytes')
    expect(saved.size).toBe(11)
    // O original não é tocado.
    expect(await fsp.readFile(source, 'utf8')).toBe('movie-bytes')
  })

  it('recusa o que não é arquivo e extensão que não guardamos', async () => {
    await expect(saveVideoAttachment({ copyFrom: work }, 'mp4')).rejects.toThrow(/not a file/)
    await expect(saveVideoAttachment({ bytes: Buffer.from('x') }, 'exe')).rejects.toThrow(/unsupported video format/)
    expect(MAX_VIDEO_ATTACHMENT_BYTES).toBeGreaterThan(1024 ** 3)
  })
})

describe('resolveAttachmentRef', () => {
  it('aceita o caminho que a nota entrega e o prefixo "ref "', async () => {
    const saved = await saveVideoAttachment({ bytes: Buffer.from('v') }, 'webm', { name: 'a.webm' })
    expect((await resolveAttachmentRef(`ref ${saved.id}`))?.id).toBe(saved.id)
    expect((await resolveAttachmentRef(saved.file))?.id).toBe(saved.id)
  })

  it('só abre anexos: nada fora da pasta, nada que não esteja lá', async () => {
    expect(await resolveAttachmentRef('/etc/passwd')).toBeNull()
    expect(await resolveAttachmentRef('../vdo_a.mp4')).toBeNull()
    expect(await resolveAttachmentRef('vdo_naoexiste.mp4')).toBeNull()
    expect(await resolveAttachmentRef(path.join(work, 'original.mov'))).toBeNull()
    expect(await resolveAttachmentRef('')).toBeNull()
  })

  it('imagem e áudio vêm do acervo de mídia', async () => {
    const image = path.join(work, 'photo.gif')
    await fsp.writeFile(image, 'GIF89a')
    mediaEntries['img_ab1.gif'] = { id: 'img_ab1.gif', path: image, name: 'dança.gif' }
    // Um GIF guardado resolve pela URL do scheme, com o nome original.
    expect(await resolveAttachmentRef('orbit-media://img_ab1.gif')).toMatchObject({ kind: 'image', name: 'dança.gif' })
    mediaEntries['img_ab2.png'] = { id: 'img_ab2.png', path: image, name: 'foto.png' }
    expect(await resolveAttachmentRef('img_ab2.png')).toMatchObject({ kind: 'image', file: image, name: 'foto.png' })
    // Entrada do índice cujo arquivo sumiu: não resolve.
    mediaEntries['img_ab3.png'] = { id: 'img_ab3.png', path: path.join(work, 'gone.png') }
    expect(await resolveAttachmentRef('img_ab3.png')).toBeNull()
  })
})

describe('videoPathFromFileUrl', () => {
  it('desfaz o file:// do renderer, com espaços e acentos', () => {
    expect(videoPathFromFileUrl('file:///Users/a%20b/Meu%20V%C3%ADdeo.mp4')).toBe('/Users/a b/Meu Vídeo.mp4')
  })

  it('só serve para arquivo de vídeo de verdade: o nome declarado não conta', () => {
    expect(videoPathFromFileUrl('file:///etc/passwd')).toBeNull()
    expect(videoPathFromFileUrl('file:///Users/a/segredo.txt')).toBeNull()
    expect(videoPathFromFileUrl('data:video/mp4;base64,AAAA')).toBeNull()
    expect(videoPathFromFileUrl('/Users/a/clip.mp4')).toBeNull()
  })
})
