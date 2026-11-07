import { BrowserWindow, ipcMain } from 'electron'
import { AGENT_CHANNELS as CH, type AgentsSnapshot } from '@shared/agents'
import { describeBuiltins } from '../profiles/describe'
import { agentEvents, duplicateAgent, loadAgents, removeAgent, saveAgent } from './store'

/** IPC of the Specialists page: the person's agents plus the description of the built-ins. */
async function snapshot(): Promise<AgentsSnapshot> {
  return { agents: await loadAgents(), builtins: describeBuiltins() }
}

export function registerAgentsIpc(): void {
  agentEvents.on('changed', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CH.changed)
    }
  })
  ipcMain.handle(CH.snapshot, snapshot)
  // `id` absent creates; present replaces the editable part. The renderer's payload is untrusted:
  // the store validates and clamps it.
  ipcMain.handle(CH.save, (_e, input: unknown, id?: string) => saveAgent(input, typeof id === 'string' ? id : undefined))
  ipcMain.handle(CH.duplicate, (_e, id: string, copyLabel: string) =>
    duplicateAgent(String(id), typeof copyLabel === 'string' ? copyLabel.slice(0, 20) : 'copy'),
  )
  ipcMain.handle(CH.remove, (_e, id: string) => removeAgent(String(id)))
}
