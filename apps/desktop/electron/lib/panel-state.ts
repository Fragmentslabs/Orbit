import { ipcMain } from 'electron'
import type { PanelSnapshot } from '@shared/panel'

/**
 * Último snapshot do painel lateral por sessão de chat, enviado pelo renderer
 * (ver o subscribe em src/stores/panel-store.ts). O agente lê daqui pela tool
 * `read_open_panel`; nada é persistido — é só o retrato do que está na tela.
 */
const snapshots = new Map<string, PanelSnapshot>()

/** Guarda o retrato do painel de uma sessão (chamado pelo IPC abaixo). */
export function setPanelSnapshot(snapshot: PanelSnapshot): void {
  if (!snapshot || typeof snapshot.sessionId !== 'string' || !Array.isArray(snapshot.tabs)) return
  snapshots.set(snapshot.sessionId, snapshot)
}

export function registerPanelStateIpc(): void {
  ipcMain.on('panel:snapshot', (_event, snapshot: PanelSnapshot) => setPanelSnapshot(snapshot))
}

/** Snapshot mais recente da sessão, quando o renderer já mandou algum. */
export function panelSnapshotFor(sessionId: string): PanelSnapshot | undefined {
  return snapshots.get(sessionId)
}
