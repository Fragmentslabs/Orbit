/**
 * State of the side panel, mirrored from the renderer to the main.
 *
 * The tabs live in the renderer store (per chat session). The agent runs in the
 * main and cannot reach that store, so the renderer pushes a small snapshot
 * on every change and the `read_open_panel` tool reads the last one. It is state of the app
 * itself — no OS permission, no screen capture.
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
  | 'slides'
  | 'memory'

export interface PanelSnapshotTab {
  id: string
  type: PanelSnapshotTabType
  title: string
  artifactId?: string
  motionId?: string
  motionPath?: string
  designId?: string
  designPath?: string
  slidesId?: string
  slidesPath?: string
  slidesEntry?: string
  documentId?: string
  url?: string
  sourceDocId?: string
  memoryId?: string
}

export interface PanelSnapshot {
  sessionId: string
  activeTabId: string | null
  tabs: PanelSnapshotTab[]
  updatedAt: number
}
