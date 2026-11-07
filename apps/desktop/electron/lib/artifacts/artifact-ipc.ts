import { BrowserWindow, ipcMain } from 'electron'
import { ARTIFACT_CHATS_CHANNELS as CH, type ArtifactChatsEvent, type ArtifactRef } from '@shared/artifacts'
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
}
