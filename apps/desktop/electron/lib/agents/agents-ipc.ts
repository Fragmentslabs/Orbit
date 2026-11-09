import { BrowserWindow, ipcMain } from 'electron'
import { AGENT_CHANNELS as CH, type AgentsSnapshot } from '@shared/agents'
import { CORE } from '../tools/catalog'
import type { RoutineModel } from '@shared/routines'
import { generateAgent } from './generator'
import { describeAgents, describeBuiltins } from '../profiles/describe'
import { refreshPinnedSkills } from './pinned-skills'
import { loadOverrides, resetOverride, saveOverride } from './overrides'
import { registerAgentShareIpc } from './share-ipc'
import { agentEvents, duplicateAgent, loadAgents, removeAgent, saveAgent } from './store'

/** IPC of the Specialists page: the person's agents plus the description of the built-ins. */
async function snapshot(): Promise<AgentsSnapshot> {
  const [agents, overrides] = await Promise.all([loadAgents(), loadOverrides()])
  // The weight of pinned skills is measured on their real text.
  await refreshPinnedSkills(Object.values(overrides).flatMap((o) => o.pinnedSkills ?? []))
  await refreshPinnedSkills(agents.flatMap((a) => a.pinnedSkills))
  return { agents, builtins: describeBuiltins(), described: describeAgents(agents), overrides }
}

export function registerAgentsIpc(): void {
  agentEvents.on('changed', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CH.changed)
    }
  })
  registerAgentShareIpc()
  ipcMain.handle(CH.snapshot, snapshot)
  // `id` absent creates; present replaces the editable part. The renderer's payload is untrusted:
  // the store validates and clamps it.
  ipcMain.handle(CH.save, (_e, input: unknown, id?: string) => saveAgent(input, typeof id === 'string' ? id : undefined))
  ipcMain.handle(CH.duplicate, (_e, id: string, copyLabel: string) =>
    duplicateAgent(String(id), typeof copyLabel === 'string' ? copyLabel.slice(0, 20) : 'copy'),
  )
  // The always-on tools: the names an allow-list can reasonably mention. Family tools load on demand.
  ipcMain.handle(CH.toolNames, () => [...CORE])
  ipcMain.handle(CH.generate, (_e, description: string, model: RoutineModel, folders: string[], language?: string) =>
    generateAgent(description, model, folders, language))
  ipcMain.handle(CH.saveBuiltin, (_e, id: string, override: unknown) => saveOverride(String(id), override))
  ipcMain.handle(CH.resetBuiltin, (_e, id: string) => resetOverride(String(id)))
  ipcMain.handle(CH.remove, (_e, id: string) => removeAgent(String(id)))
}
