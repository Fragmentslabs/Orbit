import { describe, expect, it } from 'vitest'

import { rewriteMediaPart, rewriteMediaUrl, rewriteMessage, rewriteMessages } from './companion-media'
import type { ChatMessage, MessagePart } from '@shared/chat'

/**
 * A costura que quebra calada.
 *
 * O celular não conhece `orbit-media://`. Se uma part carrega um endereço
 * desses e ninguém reescreve, a imagem simplesmente não aparece no app — e
 * nada falha no desktop, então o bug só é descoberto por alguém olhando o
 * celular. Estes testes existem para que uma part nova nessa situação quebre
 * AQUI, e não lá.
 */

const BASE = 'http://192.168.0.10:3848'
const token = (id: string) => `tok-${id}`

function message(parts: MessagePart[]): ChatMessage {
  return { id: 'm1', role: 'assistant', parts, createdAt: 0 } as ChatMessage
}

describe('rewriteMediaUrl', () => {
  it('troca o esquema pelo HTTP assinado', () => {
    expect(rewriteMediaUrl('orbit-media://img_abc.png', BASE, token)).toBe(
      `${BASE}/api/media/img_abc.png?t=tok-img_abc.png`,
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

describe('rewriteMediaPart', () => {
  it('reescreve a imagem que o assistente pôs na resposta', () => {
    const part = { id: 'p', type: 'image', src: 'orbit-media://img_a.png' } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { src: string }
    expect(out.src).toBe(`${BASE}/api/media/img_a.png?t=tok-img_a.png`)
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
    expect(out.mediaUrl).toBe(`${BASE}/api/media/img_b.png?t=tok-img_b.png`)
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

describe('rewriteMessage / rewriteMessages', () => {
  it('devolve null quando nada mudou — quem chama reaproveita o original', () => {
    const msg = message([{ id: 'p', type: 'text', text: 'oi' } as MessagePart])
    expect(rewriteMessage(msg, BASE, token)).toBeNull()
    expect(rewriteMessages([msg], BASE, token)).toBeNull()
  })

  it('reescreve as duas parts na mesma mensagem e preserva o resto', () => {
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
    ])
    const out = rewriteMessage(msg, BASE, token)!
    expect(out.parts[0]).toEqual(msg.parts[0])
    expect((out.parts[1] as { src: string }).src).toContain('/api/media/img_a.png')
    expect((out.parts[2] as { mediaUrl: string }).mediaUrl).toContain('/api/media/img_b.png')
    // Não muta a mensagem original: ela continua sendo a do desktop.
    expect((msg.parts[1] as { src: string }).src).toBe('orbit-media://img_a.png')
  })

  it('numa lista, só as mensagens com mídia são trocadas', () => {
    const semMidia = message([{ id: 'a', type: 'text', text: 'oi' } as MessagePart])
    const comMidia = message([{ id: 'b', type: 'image', src: 'orbit-media://img_c.png' } as MessagePart])
    const out = rewriteMessages([semMidia, comMidia], BASE, token)!
    expect(out[0]).toBe(semMidia)
    expect(out[1]).not.toBe(comMidia)
  })
})
