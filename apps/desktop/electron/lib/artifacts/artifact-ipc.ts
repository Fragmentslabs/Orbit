import { BrowserWindow, ipcMain } from 'electron'
import { ARTIFACT_CHATS_CHANNELS as CH, ARTIFACT_VIEW_CHANNEL, type ArtifactChatsEvent, type ArtifactRef, type ArtifactViewReport } from '@shared/artifacts'
import { reportView } from './view-state'
import { artifactChatEvents, associateChat, listArtifactChats, setCurrentChat } from './chat-registry'

/** IPC of the artifact chat lists — the same calls for every kind of artifact. */
export function registerArtifactIpc(): void {
  artifactChatEvents.on('changed', (event: ArtifactChatsEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CH.changed, event)
    }
  })
  ipcMain.handle(CH.list, (_e, ref: ArtifactRef) => listArtifactChats(ref))
  ipcMain.handle(CH.associate, (_e, ref: ArtifactRef, sessionId: string, makeCurrent?: boolean) =>
    associateChat(ref, sessionId, { makeCurrent }),
  )
  ipcMain.handle(CH.setCurrent, (_e, ref: ArtifactRef, sessionId: string) => setCurrentChat(ref, sessionId))
  // Fire and forget: the tab reports on every change and nobody waits for an answer.
  ipcMain.on(ARTIFACT_VIEW_CHANNEL, (_e, report: ArtifactViewReport) => reportView(report))
}
