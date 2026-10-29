import { describe, expect, it } from 'vitest'

import { rewriteMediaPart, rewriteMediaUrl, rewriteMessage, rewriteMessages } from './companion-media'
import type { ChatMessage, MessagePart } from '@shared/chat'

/**
 * A costura que quebra calada.
 *
 * O celular não conhece os schemes do Electron (`orbit-media://`,
 * `orbit-audio://`, `orbit-video://`, `orbit-artifact://`). Se uma part carrega
 * um endereço desses e ninguém reescreve, o arquivo simplesmente não aparece no
 * app — e nada falha no desktop, então o bug só é descoberto por alguém olhando
 * o celular. Estes testes existem para que uma part nova nessa situação quebre
 * AQUI, e não lá.
 */

const BASE = 'http://192.168.0.10:3848'
const token = (scope: string, id: string) => `tok-${scope}-${id}`

function message(parts: MessagePart[]): ChatMessage {
  return { id: 'm1', role: 'assistant', parts, createdAt: 0 } as ChatMessage
}

describe('rewriteMediaUrl', () => {
  it('troca o esquema pelo HTTP assinado', () => {
    expect(rewriteMediaUrl('orbit-media://img_abc.png', BASE, token)).toBe(
      `${BASE}/api/media/img_abc.png?t=tok-media-img_abc.png`,
    )
  })

  it('deixa em paz o que não é endereço de mídia', () => {
    // Um data URL já é carregável pelo app; reescrever seria estragá-lo.
    expect(rewriteMediaUrl('data:image/png;base64,AAAA', BASE, token)).toBeNull()
    expect(rewriteMediaUrl('https://exemplo.com/a.png', BASE, token)).toBeNull()
    expect(rewriteMediaUrl(undefined, BASE, token)).toBeNull()
  })

  it('recusa um id fora do formato que nós geramos', () => {
    // Path traversal ou extensão estranha não viram URL servida.
    expect(rewriteMediaUrl('orbit-media://../secrets.png', BASE, token)).toBeNull()
    expect(rewriteMediaUrl('orbit-media://x.exe', BASE, token)).toBeNull()
  })
})

describe('rewriteMediaPart — imagem e anexo', () => {
  it('reescreve a imagem que o assistente pôs na resposta', () => {
    const part = { id: 'p', type: 'image', src: 'orbit-media://img_a.png' } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { src: string }
    expect(out.src).toBe(`${BASE}/api/media/img_a.png?t=tok-media-img_a.png`)
  })

  it('reescreve o mediaUrl do chip de anexo — a foto original', () => {
    // Sem isto o chip chega com orbit-media:// cru e o anexo aparece quebrado
    // no celular, que é PIOR do que ele abrir a versão pequena.
    const part = {
      id: 'p',
      type: 'file',
      mime: 'image/png',
      url: 'data:image/webp;base64,THUMB',
      mediaUrl: 'orbit-media://img_b.png',
      chip: true,
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { url: string; mediaUrl: string }
    expect(out.mediaUrl).toBe(`${BASE}/api/media/img_b.png?t=tok-media-img_b.png`)
    // E o thumbnail embutido continua intacto: é ele que a lista desenha.
    expect(out.url).toBe('data:image/webp;base64,THUMB')
  })

  it('chip sem mediaUrl (anexo antigo) não é tocado', () => {
    const part = {
      id: 'p',
      type: 'file',
      mime: 'image/png',
      url: 'data:image/webp;base64,THUMB',
      chip: true,
    } as MessagePart
    expect(rewriteMediaPart(part, BASE, token)).toBeNull()
  })

  it('part que não carrega mídia passa direto', () => {
    expect(rewriteMediaPart({ id: 'p', type: 'text', text: 'oi' } as MessagePart, BASE, token)).toBeNull()
  })
})

describe('rewriteMediaPart — áudio e vídeo', () => {
  it('reescreve o áudio do audio_generate com o token no caminho', () => {
    const part = {
      id: 'p',
      type: 'audio',
      src: 'orbit-audio://aud_abc123.wav',
      title: 'narração',
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { src: string; title: string }
    expect(out.src).toBe(`${BASE}/api/file/audio/aud_abc123.wav/tok-audio-aud_abc123.wav`)
    // O resto da part sobrevive — o player mostra o título.
    expect(out.title).toBe('narração')
  })

  it('reescreve o vídeo do video_render', () => {
    const part = { id: 'p', type: 'video', src: 'orbit-video://vid_abc123' } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { src: string }
    expect(out.src).toBe(`${BASE}/api/file/video/vid_abc123/tok-video-vid_abc123`)
  })

  it('não inventa URL a partir de um endereço que não é nosso', () => {
    const audio = { id: 'p', type: 'audio', src: 'https://exemplo.com/a.mp3' } as MessagePart
    const video = { id: 'p', type: 'video', src: 'data:video/mp4;base64,AA' } as MessagePart
    expect(rewriteMediaPart(audio, BASE, token)).toBeNull()
    expect(rewriteMediaPart(video, BASE, token)).toBeNull()
  })

  it('recusa id fora dos formatos que nós geramos', () => {
    // O prefixo importa: o escopo confia nele para achar o arquivo.
    const errado = { id: 'p', type: 'audio', src: 'orbit-audio://qualquer.wav' } as MessagePart
    const traversal = { id: 'p', type: 'video', src: 'orbit-video://../../etc/passwd' } as MessagePart
    expect(rewriteMediaPart(errado, BASE, token)).toBeNull()
    expect(rewriteMediaPart(traversal, BASE, token)).toBeNull()
  })
})

describe('rewriteMediaPart — artefato e documento', () => {
  it('reescreve a página do artefato e a miniatura', () => {
    const part = {
      id: 'p',
      type: 'artifact',
      src: 'orbit-artifact://art_abc.html',
      artifactId: 'art_abc.html',
      title: 'Dashboard',
      thumb: 'orbit-artifact://art_abc.png',
      revision: 2,
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { src: string; thumb: string; title: string }
    expect(out.src).toBe(`${BASE}/api/file/artifact/art_abc.html/tok-artifact-art_abc.html`)
    expect(out.thumb).toBe(`${BASE}/api/file/artifact/art_abc.png/tok-artifact-art_abc.png`)
    expect(out.title).toBe('Dashboard')
  })

  it('artefato sem miniatura não ganha um thumb inventado', () => {
    const part = {
      id: 'p',
      type: 'artifact',
      src: 'orbit-artifact://art_xyz.html',
      artifactId: 'art_xyz.html',
      title: 'Sem thumb',
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { thumb?: string }
    expect(out.thumb).toBeUndefined()
  })

  it('documento aponta o preview HTML, não o Markdown', () => {
    const part = {
      id: 'p',
      type: 'document',
      documentId: 'doc_abc.md',
      title: 'Relatório',
      previewSrc: 'orbit-artifact://doc_abc.html',
      formats: [],
      thumb: 'orbit-artifact://doc_abc.png',
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { previewSrc: string; thumb: string }
    expect(out.previewSrc).toBe(`${BASE}/api/file/artifact/doc_abc.html/tok-artifact-doc_abc.html`)
    expect(out.thumb).toBe(`${BASE}/api/file/artifact/doc_abc.png/tok-artifact-doc_abc.png`)
  })
})

describe('rewriteMessage / rewriteMessages', () => {
  it('devolve null quando nada mudou — quem chama reaproveita o original', () => {
    const msg = message([{ id: 'p', type: 'text', text: 'oi' } as MessagePart])
    expect(rewriteMessage(msg, BASE, token)).toBeNull()
    expect(rewriteMessages([msg], BASE, token)).toBeNull()
  })

  it('reescreve todas as parts com arquivo na mesma mensagem e preserva o resto', () => {
    const msg = message([
      { id: 'p1', type: 'text', text: 'segue a foto' } as MessagePart,
      { id: 'p2', type: 'image', src: 'orbit-media://img_a.png' } as MessagePart,
      {
        id: 'p3',
        type: 'file',
        mime: 'image/png',
        url: 'data:image/webp;base64,T',
        mediaUrl: 'orbit-media://img_b.png',
        chip: true,
      } as MessagePart,
      { id: 'p4', type: 'audio', src: 'orbit-audio://aud_z9.wav' } as MessagePart,
    ])
    const out = rewriteMessage(msg, BASE, token)!
    expect(out.parts[0]).toEqual(msg.parts[0])
    expect((out.parts[1] as { src: string }).src).toContain('/api/media/img_a.png')
    expect((out.parts[2] as { mediaUrl: string }).mediaUrl).toContain('/api/media/img_b.png')
    expect((out.parts[3] as { src: string }).src).toContain('/api/file/audio/aud_z9.wav/')
    // Não muta a mensagem original: ela continua sendo a do desktop.
    expect((msg.parts[1] as { src: string }).src).toBe('orbit-media://img_a.png')
  })

  it('numa lista, só as mensagens com arquivo são trocadas', () => {
    const semMidia = message([{ id: 'a', type: 'text', text: 'oi' } as MessagePart])
    const comMidia = message([{ id: 'b', type: 'image', src: 'orbit-media://img_c.png' } as MessagePart])
    const comVideo = message([{ id: 'c', type: 'video', src: 'orbit-video://vid_q1' } as MessagePart])
    const out = rewriteMessages([semMidia, comMidia, comVideo], BASE, token)!
    expect(out[0]).toBe(semMidia)
    expect(out[1]).not.toBe(comMidia)
    expect(out[2]).not.toBe(comVideo)
  })
})
