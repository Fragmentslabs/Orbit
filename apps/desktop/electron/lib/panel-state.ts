import { ipcMain } from 'electron'
import type { PanelSnapshot } from '@shared/panel'

/**
 * Last snapshot of the side panel per chat session, sent by the renderer
 * (see the subscribe in src/stores/panel-store.ts). The agent reads from here through the
 * `read_open_panel` tool; nothing is persisted — it is only the portrait of what is on the screen.
 */
const snapshots = new Map<string, PanelSnapshot>()

/** Keeps a session's panel portrait (called by the IPC below). */
export function setPanelSnapshot(snapshot: PanelSnapshot): void {
  if (!snapshot || typeof snapshot.sessionId !== 'string' || !Array.isArray(snapshot.tabs)) return
  snapshots.set(snapshot.sessionId, snapshot)
}

export function registerPanelStateIpc(): void {
  ipcMain.on('panel:snapshot', (_event, snapshot: PanelSnapshot) => setPanelSnapshot(snapshot))
}

/** Most recent snapshot of the session, when the renderer has already sent one. */
export function panelSnapshotFor(sessionId: string): PanelSnapshot | undefined {
  return snapshots.get(sessionId)
}
