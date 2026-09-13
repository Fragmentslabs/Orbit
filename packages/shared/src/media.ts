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

/**
 * Imagem (o caso histórico), artefato HTML renderizável, ou documento
 * (relatório/proposta autorado pelo agente, entregue em PDF e/ou DOCX).
 * Ausente em registros gravados antes disso existir = "image".
 */
export type MediaKind = "image" | "artifact" | "document"

/** Formatos de entrega de um documento. O fonte é sempre Markdown; estes são
 *  os arquivos renderizados a partir dele. */
export type DocumentFormat = "pdf" | "docx"

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
  /** Só em documentos: quais renderizações existem em disco. */
  formats?: DocumentFormat[]
  /**
   * Projeto a que o ativo pertence — a pasta de trabalho da sessão que o
   * criou, capturada NO MOMENTO da criação.
   *
   * A galeria já derivava isso da sessão, mas derivar não basta para duas
   * coisas: o vínculo morre quando a sessão é excluída, e o AGENTE não tem
   * como achar o que produziu antes no mesmo repositório. Gravado aqui, o
   * documento continua encontrável pelo projeto mesmo sem a conversa.
   */
  directory?: string
  /** Pasta da sidebar em que a sessão estava (modo chat, onde não há
   *  diretório) — o equivalente de `directory` para o agrupamento manual. */
  folderId?: string
}

export interface MediaFilter {
  source?: MediaSource | MediaSource[]
  kind?: MediaKind | MediaKind[]
  sessionId?: string
  /** Escopo por projeto: todos os ativos daquela pasta de trabalho,
   *  independentemente da sessão que os criou. */
  directory?: string
  folderId?: string
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

/**
 * URL que ABRE o ativo: a imagem em si, o HTML do artefato, ou — no
 * documento — o HTML de preview, porque o Electron não tem visualizador de
 * PDF e o .docx não é renderizável no navegador. PDF e DOCX são entrega
 * (abrir fora, exportar), não visualização embutida.
 */
export function assetUrl(entry: Pick<MediaEntry, "id" | "kind">): string {
  const kind = mediaKind(entry)
  if (kind === "artifact") return `${ARTIFACT_SCHEME}://${entry.id}`
  if (kind === "document") return `${ARTIFACT_SCHEME}://${documentPreviewId(entry.id)}`
  return `${MEDIA_SCHEME}://${entry.id}`
}

/** O id do documento é o do FONTE (doc_x.md); o preview é o irmão .html. */
export function documentPreviewId(id: string): string {
  return id.replace(/\.md$/, '.html')
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

/** Nome de arquivo seguro a partir do título, para exportar/salvar. */
export function documentFileName(title: string, format: DocumentFormat): string {
  const base = title.replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 60) || "documento"
  return `${base}.${format}`
}
