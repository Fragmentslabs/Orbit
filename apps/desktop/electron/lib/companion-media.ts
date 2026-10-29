import type { ChatMessage, MessagePart, PieceKind, ToolPart } from '@shared/chat'

/**
 * Endereços de arquivo reescritos para o app mobile.
 *
 * O celular não conhece os schemes do Electron — `orbit-media://` para imagem,
 * `orbit-audio://` para áudio, `orbit-video://` para vídeo, `orbit-artifact://`
 * para artefato e documento. Todos são registrados só no main, então tudo que
 * sai daqui vira uma URL HTTP assinada que o app alcança pelo mesmo host que
 * ele usou para conectar.
 *
 * Módulo separado do servidor, e sem Electron dentro, porque esta é uma costura
 * que quebra CALADA: basta uma part nova carregar endereço de um scheme novo e
 * ninguém reescrever para ela sumir no celular sem nenhum erro no desktop. A
 * fábrica de token entra por parâmetro para o módulo continuar testável.
 */

/** Só os ids que nós mesmos geramos, e só formatos de imagem. */
const MEDIA_URL_RE = /^orbit-media:\/\/([a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif))$/
/** Mesmo padrão de SAFE_AUDIO_ID (media.ts) — o id É o nome do arquivo. */
const AUDIO_URL_RE = /^orbit-audio:\/\/(aud_[a-z0-9]+\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac))$/
/** Mesmo padrão de SAFE_VIDEO_ID (video/store.ts). */
const VIDEO_URL_RE = /^orbit-video:\/\/(vid_[a-z0-9]+)$/
/** Mesmo padrão de SAFE_ARTIFACT_ID (media.ts): página, miniatura, fonte e
 *  renderizações de documento. */
const ARTIFACT_URL_RE = /^orbit-artifact:\/\/([a-zA-Z0-9_-]+\.(html|png|md|pdf|docx))$/

/** Escopos que o celular busca por HTTP (ver companion-assets.ts). */
export type AssetScope =
  | 'media'
  | 'artifact'
  | 'audio'
  | 'video'
  | 'motion'
  | 'design'
  | 'slides'

/**
 * Tools que escrevem peça. O que elas devolvem não é mídia: é uma UI interativa
 * que mora numa pasta do desktop, e o celular só consegue desenhar depois de
 * saber onde ela está — daí a URL viajar no part, e não ser montada lá.
 */
const PIECE_TOOLS: Record<string, PieceKind> = {
  motion_write: 'motion',
  motion_edit: 'motion',
  design_write: 'design',
  design_edit: 'design',
  slides_write: 'slides',
  slides_edit: 'slides',
}

/** Id da peça no resultado da tool — JSON quando dá, regex quando vem solto. */
const PIECE_ID_RE = /\b((?:mv|dsg|sld)_[a-z0-9]+)\b/

function pieceIdOf(part: ToolPart): string | undefined {
  const output = part.output
  if (!output) return undefined
  try {
    const parsed = JSON.parse(output) as { id?: unknown; piece?: { id?: unknown } }
    const candidate = parsed.piece?.id ?? parsed.id
    if (typeof candidate === 'string') return candidate
  } catch {
    // saída em texto corrido: cai no regex abaixo
  }
  return PIECE_ID_RE.exec(output)?.[1]
}

export type MediaTokenFactory = (scope: AssetScope, id: string) => string

/**
 * A URL HTTP assinada, ou null quando não é endereço de mídia (fica como está).
 *
 * Imagem mantém a rota histórica (`/api/media/<id>?t=`), que já está entregue e
 * funcionando no celular. Os outros escopos nascem com o token no CAMINHO
 * (`/api/file/<escopo>/<id>/<token>`), que é o que faz o `base.css` de uma peça
 * e o thumbnail de um artefato herdarem a autorização sem reescrita.
 */
export function rewriteMediaUrl(
  url: string | undefined,
  base: string,
  token: MediaTokenFactory,
): string | null {
  const id = url ? MEDIA_URL_RE.exec(url)?.[1] : undefined
  return id ? `${base}/api/media/${id}?t=${token('media', id)}` : null
}

/** URL de um arquivo servido pelo escopo dado, com o token no caminho. */
export function assetUrl(
  scope: AssetScope,
  id: string,
  base: string,
  token: MediaTokenFactory,
): string {
  return `${base}/api/file/${scope}/${encodeURIComponent(id)}/${token(scope, id)}`
}

function rewriteScopedUrl(
  url: string | undefined,
  scope: AssetScope,
  pattern: RegExp,
  base: string,
  token: MediaTokenFactory,
): string | null {
  const id = url ? pattern.exec(url)?.[1] : undefined
  return id ? assetUrl(scope, id, base, token) : null
}

/**
 * As parts que carregam endereço de arquivo, cada uma por um motivo diferente.
 *
 * - `image` é a imagem que o assistente pôs na resposta.
 * - `file` é o chip de anexo: a `url` é um thumbnail embutido e o `mediaUrl`
 *   aponta para a foto original na galeria — é o que o visualizador amplia.
 * - `audio` é o áudio do `audio_generate`: o player toca pelo HTTP.
 * - `video` é o vídeo do `video_render`/`show_video`, que continua no projeto
 *   do usuário e é servido por Range.
 * - `artifact` é a página do `create_artifact`; o `thumb` é a miniatura que a
 *   galeria e o card usam.
 * - `document` mostra o preview HTML (`previewSrc`), não o Markdown — no
 *   celular, é o que dá para renderizar.
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
  if (part.type === 'audio') {
    const src = rewriteScopedUrl(part.src, 'audio', AUDIO_URL_RE, base, token)
    return src ? { ...part, src } : null
  }
  if (part.type === 'video') {
    const src = rewriteScopedUrl(part.src, 'video', VIDEO_URL_RE, base, token)
    return src ? { ...part, src } : null
  }
  if (part.type === 'artifact') {
    const src = rewriteScopedUrl(part.src, 'artifact', ARTIFACT_URL_RE, base, token)
    if (!src) return null
    const thumb = rewriteScopedUrl(part.thumb, 'artifact', ARTIFACT_URL_RE, base, token)
    return { ...part, src, ...(thumb ? { thumb } : {}) }
  }
  if (part.type === 'document') {
    const previewSrc = rewriteScopedUrl(part.previewSrc, 'artifact', ARTIFACT_URL_RE, base, token)
    if (!previewSrc) return null
    const thumb = rewriteScopedUrl(part.thumb, 'artifact', ARTIFACT_URL_RE, base, token)
    return { ...part, previewSrc, ...(thumb ? { thumb } : {}) }
  }
  if (part.type === 'tool') {
    const kind = PIECE_TOOLS[part.tool]
    if (!kind) return null
    const id = pieceIdOf(part)
    if (!id) return null
    // Design não tem um HTML único: é um canvas com várias telas. O celular
    // recebe o `canvas.json` e escolhe qual abrir; motion e slides desenham o
    // `index.html` direto (o companion resolve a entrada padrão do escopo).
    const url =
      kind === 'design'
        ? `${assetUrl('design', id, base, token)}/canvas.json`
        : assetUrl(kind, id, base, token)
    const title = typeof part.input?.title === 'string' ? part.input.title : part.title
    return { ...part, piece: { kind, id, url, ...(title ? { title } : {}) } }
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
