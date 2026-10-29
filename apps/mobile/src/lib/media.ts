import { mediaKind, type MediaEntry, type MediaKind } from '@orbit/shared'

/**
 * A galeria do celular mostra TUDO o que o desktop produz, e cada tipo pede um
 * tratamento diferente: só a imagem tem miniatura (o <Image> resolve), áudio e
 * vídeo abrem em player, e artefato/documento/peça são PÁGINAS (WebView). No
 * tile, nenhum deles tem o que desenhar — vira cartão com ícone + título, que
 * era o que faltava quando tudo era renderizado como <Image> e quebrava.
 *
 * O `url` de cada entrada já vem pronto do desktop (`GET /api/media`): cada tipo
 * com o token do seu escopo em `/api/file/<escopo>/<id>/<token>`. Aqui não se
 * monta URL nenhuma — só se decide COMO mostrar o que veio.
 */

/** A ordem dos chips do filtro de tipo — a mesma do desktop, mídia primeiro. */
export const KIND_ORDER: readonly MediaKind[] = [
  'image',
  'artifact',
  'document',
  'video',
  'audio',
  'motion',
  'design',
  'slides',
]

/** O tipo da entrada (registro antigo não tem `kind` = imagem). */
export function kindOf(entry: MediaEntry): MediaKind {
  return mediaKind(entry)
}

/**
 * Chave do rótulo do tipo, para o cartão do tile e para o chip do filtro. Fica a
 * chave e não o texto porque este módulo não chama hook: quem renderiza resolve
 * com `t(KIND_KEY[kind])`.
 */
export const KIND_KEY: Record<MediaKind, string> = {
  image: 'media.kind.image',
  artifact: 'media.kind.artifact',
  document: 'media.kind.document',
  video: 'media.kind.video',
  audio: 'media.kind.audio',
  motion: 'media.kind.motion',
  design: 'media.kind.design',
  slides: 'media.kind.slides',
}

/** Título do item: o rótulo do registro ou, sem ele, o nome do arquivo. */
export function entryTitle(entry: MediaEntry): string {
  const name = entry.name?.trim()
  return name && name.length > 0 ? name : entry.id
}

/**
 * A entrada tem para onde abrir. Falso quando a peça saiu do registro do desktop
 * (a pasta sumiu, o registro foi limpo): o tile continua na galeria — o item
 * existe no índice — mas não há documento para carregar.
 */
export function canOpen(entry: MediaEntry): boolean {
  return typeof entry.url === 'string' && entry.url.length > 0
}
