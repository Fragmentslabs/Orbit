import { BrowserWindow, ipcMain } from 'electron'
import type { FragmentCallInput, FragmentLogEntry, FragmentMetaPatch, FragmentUpdatedEvent } from '@shared/fragments'
import { FRAGMENT_CAPABILITIES } from '@shared/fragments'
import { handleFragmentCall } from './fragment-bridge'
import { getFragmentDetails } from './fragment-details'
import { getProvenance } from './fragment-provenance'
import {
  appendFragmentLog,
  fragmentEvents,
  getFragment,
  isFragmentId,
  listFragments,
  removeFragment,
  setGrant,
  updateFragmentMeta,
} from './fragment-store'

function sendToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

const LOG_LEVELS = new Set(['log', 'info', 'warn', 'error'])

/**
 * IPC of the fragments — the renderer (the tab that hosts the iframe) is the courier
 * between the page and the main process; the decisions are all made on this side.
 */
export function registerFragmentIpc(): void {
  fragmentEvents.on('updated', (event: FragmentUpdatedEvent) => sendToWindows('fragment:updated', event))

  ipcMain.handle('fragment:list', () => listFragments())
  ipcMain.handle('fragment:get', (_event, id: string) => getFragment(id))
  // Read-only: the record is written by Orbit's own flows, never through IPC.
  ipcMain.handle('fragment:provenance', async (_event, id: string) => {
    const manifest = await getFragment(id)
    return manifest ? getProvenance(id, manifest.createdAt) : null
  })
  // Read-only numbers for the details panel (weight, data keys, token spend, origin).
  ipcMain.handle('fragment:details', (_event, id: string) => (isFragmentId(id) ? getFragmentDetails(id) : null))
  ipcMain.handle('fragment:call', (_event, input: FragmentCallInput) => handleFragmentCall(input))

  // The ONLY place a capability is granted: a click of the user in the tab.
  ipcMain.handle('fragment:grant', async (_event, id: string, capability: string, on: boolean) => {
    if (!isFragmentId(id)) return null
    const cap = FRAGMENT_CAPABILITIES.find((c) => c === capability)
    if (!cap) return null
    const manifest = await setGrant(id, cap, on === true)
    if (manifest) sendToWindows('fragment:updated', { fragmentId: id, revision: manifest.revision } satisfies FragmentUpdatedEvent)
    return manifest
  })

  // Name, pins, model and the editing chat: the person's choices, never the agent's.
  ipcMain.handle('fragment:update', (_event, id: string, patch: FragmentMetaPatch) => {
    if (!isFragmentId(id) || !patch || typeof patch !== 'object') return null
    return updateFragmentMeta(id, patch)
  })

  ipcMain.handle('fragment:remove', async (_event, id: string) => {
    const removed = await removeFragment(id)
    if (removed) sendToWindows('fragment:removed', { fragmentId: id })
    return removed
  })

  // The page's console, forwarded by the tab (see fragment_logs).
  ipcMain.on('fragment:log', (_event, id: string, entry: FragmentLogEntry) => {
    if (!isFragmentId(id) || !entry || typeof entry.message !== 'string') return
    const level = LOG_LEVELS.has(entry.level) ? entry.level : 'log'
    appendFragmentLog(id, { at: Date.now(), level, message: entry.message })
  })
}
