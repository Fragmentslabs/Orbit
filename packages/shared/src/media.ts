/**
 * Registry de mídia: toda imagem produzida pelo agente (show_image,
 * screenshots, scripts de browser) ou colada pelo usuário ganha um registro
 * em orbit-data/media/index.json. A galeria do painel direito lê daqui.
 */

export type MediaSource = "chat" | "user" | "screenshot" | "script" | "batch"

export interface MediaEntry {
  /** Nome do arquivo em orbit-data/media (também é a URL: orbit-media://<id>) */
  id: string
  /** URL pronta para exibir. No desktop é orbit-media://<id>; no companion o
   *  servidor preenche com http://host/api/media/<id>?t=<token assinado>. */
  url?: string
  /** Caminho absoluto no disco */
  path: string
  size: number
  createdAt: number
  source: MediaSource
  /** Chat que originou a imagem (quando veio de uma tool) */
  sessionId?: string
  /** Mensagem do assistente onde a imagem aparece */
  messageId?: string
  /** Tarefa de run_browser_script/capture_batch que gerou a imagem */
  taskId?: string
  /** Rótulo dado pelo script (capture('home')) ou legenda do show_image */
  name?: string
  width?: number
  height?: number
}

export interface MediaFilter {
  source?: MediaSource | MediaSource[]
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
