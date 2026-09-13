/**
 * Registry de ativos produzidos pelo agente: toda imagem (show_image,
 * screenshots, scripts de browser), toda imagem colada pelo usuário e todo
 * artefato HTML (create_artifact) ganham um registro em
 * orbit-data/media/index.json. A galeria do painel direito lê daqui.
 *
 * O índice é único, mas o BYTE mora onde faz sentido: imagens em
 * orbit-data/media, artefatos em orbit-data/artifacts. Nada é duplicado — o
 * registro é um ponteiro (`path` é absoluto) e `kind` diz como abrir.
 */

export type MediaSource = "chat" | "user" | "screenshot" | "script" | "batch"

/** Imagem (o caso histórico) ou artefato HTML renderizável.
 *  Ausente em registros gravados antes dos artefatos existirem = "image". */
export type MediaKind = "image" | "artifact"

export interface MediaEntry {
  /** Nome do arquivo (também é a URL: orbit-media://<id> ou orbit-artifact://<id>) */
  id: string
  /** URL pronta para exibir. No desktop vem de `assetUrl`; no companion o
   *  servidor preenche com http://host/api/media/<id>?t=<token assinado>. */
  url?: string
  /** Caminho absoluto no disco — a fonte da verdade para ler/apagar o arquivo,
   *  já que imagens e artefatos vivem em diretórios diferentes. */
  path: string
  size: number
  createdAt: number
  source: MediaSource
  kind?: MediaKind
  /** Chat que originou o ativo (quando veio de uma tool) */
  sessionId?: string
  /** Mensagem do assistente onde o ativo aparece */
  messageId?: string
  /** Tarefa de run_browser_script/capture_batch que gerou a imagem */
  taskId?: string
  /** Rótulo dado pelo script (capture('home')), legenda do show_image ou
   *  título do artefato */
  name?: string
  width?: number
  height?: number
  /** Só em artefatos: id do PNG de miniatura (mesma pasta do .html), capturado
   *  na criação para a galeria continuar sendo um grid de imagens. Ausente
   *  quando a captura falhou — o tile cai no ícone. */
  thumb?: string
  /** Só em artefatos: incrementa a cada update_artifact. O arquivo é reescrito
   *  no lugar (a URL não muda), então é isto que invalida o cache do iframe. */
  revision?: number
}

export interface MediaFilter {
  source?: MediaSource | MediaSource[]
  kind?: MediaKind | MediaKind[]
  sessionId?: string
  /** createdAt >= since */
  since?: number
  /** Busca (case-insensitive) em name/taskId/id */
  query?: string
}

export interface MediaUsage {
  count: number
  bytes: number
}

export const MEDIA_SCHEME = "orbit-media"
export const ARTIFACT_SCHEME = "orbit-artifact"

/** `kind` normalizado — registros antigos não têm o campo. */
export function mediaKind(entry: Pick<MediaEntry, "kind">): MediaKind {
  return entry.kind ?? "image"
}

/** URL que ABRE o ativo: a imagem em si, ou o HTML do artefato. */
export function assetUrl(entry: Pick<MediaEntry, "id" | "kind">): string {
  return mediaKind(entry) === "artifact"
    ? `${ARTIFACT_SCHEME}://${entry.id}`
    : `${MEDIA_SCHEME}://${entry.id}`
}

/**
 * URL da MINIATURA para o grid — null quando o artefato não tem captura e o
 * tile precisa cair no ícone.
 *
 * A miniatura do artefato é reescrita com o MESMO nome a cada
 * update_artifact, então a revisão entra na query: sem ela o grid continuaria
 * exibindo a captura da versão anterior.
 */
export function thumbUrl(
  entry: Pick<MediaEntry, "id" | "kind" | "thumb" | "revision">,
): string | null {
  if (mediaKind(entry) === "image") return `${MEDIA_SCHEME}://${entry.id}`
  return entry.thumb ? `${ARTIFACT_SCHEME}://${entry.thumb}?rev=${entry.revision ?? 1}` : null
}
