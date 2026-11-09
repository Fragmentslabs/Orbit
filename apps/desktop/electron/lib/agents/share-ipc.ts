import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { AGENT_FILE_EXTENSION, AGENT_SHARE_CHANNELS as CH, type AgentExportResult } from '@shared/agent-share'
import { cancelAgentImport, confirmAgentImport, previewAgentImport, serializeAgent } from './share'
import { loadAgents } from './store'

/** IPC of agent sharing. The export picks its destination in a native dialog; the import is preview, then confirm by token. */
export function registerAgentShareIpc(): void {
  ipcMain.handle(CH.export, async (event, id: unknown): Promise<AgentExportResult> => {
    const agent = (await loadAgents()).find((a) => a.id === id)
    if (!agent) return { ok: false }
    const { text, suggestedName } = serializeAgent(agent)
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      defaultPath: path.join(app.getPath('downloads'), suggestedName),
      filters: [{ name: 'Orbit agent', extensions: [AGENT_FILE_EXTENSION.slice(1)] }],
    }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    await fsp.writeFile(picked.filePath, text, 'utf8')
    return { ok: true, path: picked.filePath }
  })
  ipcMain.handle(CH.importPreview, (_e, fileName: unknown, text: unknown) => previewAgentImport(fileName, text))
  ipcMain.handle(CH.importConfirm, (_e, token: unknown) => confirmAgentImport(token))
  ipcMain.handle(CH.importCancel, (_e, token: unknown) => cancelAgentImport(token))
}
