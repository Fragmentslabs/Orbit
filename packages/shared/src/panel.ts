/**
 * Estado do painel lateral, espelhado do renderer para o main.
 *
 * As abas vivem no store do renderer (por sessão de chat). O agente roda no
 * main e não alcança esse store, então o renderer empurra um snapshot pequeno
 * a cada mudança e a tool `read_open_panel` lê o último. É estado do próprio
 * app — nenhuma permissão de SO, nenhuma captura de tela.
 */

export type PanelSnapshotTabType =
  | 'chat'
  | 'terminal'
  | 'process'
  | 'folders'
  | 'browser'
  | 'diff'
  | 'media'
  | 'artifact'
  | 'sources'
  | 'source'
  | 'document'
  | 'motion'
  | 'design'

export interface PanelSnapshotTab {
  id: string
  type: PanelSnapshotTabType
  title: string
  artifactId?: string
  motionId?: string
  motionPath?: string
  designId?: string
  designPath?: string
  documentId?: string
  url?: string
  sourceDocId?: string
}

export interface PanelSnapshot {
  sessionId: string
  activeTabId: string | null
  tabs: PanelSnapshotTab[]
  updatedAt: number
}
