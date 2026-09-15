import type { ChatMessage, MessagePart } from '@shared/chat'

/**
 * Endereços de mídia reescritos para o app mobile.
 *
 * O celular não conhece o esquema `orbit-media://` — ele é registrado só no
 * Electron. Toda mídia que sai daqui vira uma URL HTTP assinada que o app
 * alcança pelo mesmo host que ele usou para conectar.
 *
 * Módulo separado do servidor, e sem Electron dentro, porque esta é uma
 * costura que quebra CALADA: basta uma part nova carregar endereço de mídia e
 * ninguém reescrever para a imagem sumir no celular sem nenhum erro no
 * desktop. A fábrica de token entra por parâmetro para o módulo continuar
 * testável.
 */

/** Só os ids que nós mesmos geramos, e só formatos de imagem. */
const MEDIA_URL_RE = /^orbit-media:\/\/([a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif))$/

export type MediaTokenFactory = (id: string) => string

/** A URL HTTP assinada, ou null quando não é endereço de mídia (fica como está). */
export function rewriteMediaUrl(
  url: string | undefined,
  base: string,
  token: MediaTokenFactory,
): string | null {
  const id = url ? MEDIA_URL_RE.exec(url)?.[1] : undefined
  return id ? `${base}/api/media/${id}?t=${token(id)}` : null
}

/**
 * Duas parts carregam endereço de mídia, por motivos diferentes.
 *
 * `image` é a imagem que o assistente pôs na resposta. `file` é o chip de
 * anexo: a `url` dele é um thumbnail embutido e o `mediaUrl` aponta para a
 * foto original na galeria — é o que o visualizador amplia. Reescrever só a
 * primeira faz o chip chegar com um `orbit-media://` cru, que o app não sabe
 * carregar: o anexo apareceria quebrado em vez de abrir a versão pequena.
 */
export function rewriteMediaPart(
  part: MessagePart,
  base: string,
  token: MediaTokenFactory,
): MessagePart | null {
  if (part.type === 'image') {
    const src = rewriteMediaUrl(part.src, base, token)
    return src ? { ...part, src } : null
  }
  if (part.type === 'file') {
    const mediaUrl = rewriteMediaUrl(part.mediaUrl, base, token)
    return mediaUrl ? { ...part, mediaUrl } : null
  }
  return null
}

/** null quando nada mudou — quem chama reaproveita o objeto original. */
export function rewriteMessage(
  msg: ChatMessage,
  base: string,
  token: MediaTokenFactory,
): ChatMessage | null {
  let changed = false
  const parts = msg.parts.map((p) => {
    const rewritten = rewriteMediaPart(p, base, token)
    if (rewritten) {
      changed = true
      return rewritten
    }
    return p
  })
  return changed ? { ...msg, parts } : null
}

export function rewriteMessages(
  msgs: ChatMessage[],
  base: string,
  token: MediaTokenFactory,
): ChatMessage[] | null {
  let changed = false
  const out = msgs.map((m) => {
    const rewritten = rewriteMessage(m, base, token)
    if (rewritten) {
      changed = true
      return rewritten
    }
    return m
  })
  return changed ? out : null
}
