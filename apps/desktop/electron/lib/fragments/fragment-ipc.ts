import { BrowserWindow, ipcMain } from 'electron'
import type {
  FragmentCallInput,
  FragmentLogEntry,
  FragmentMetaPatch,
  FragmentPermissionAskEvent,
  FragmentUpdatedEvent,
} from '@shared/fragments'
import { handleFragmentCall } from './fragment-bridge'
import { deleteFragment } from './fragment-delete'
import { grantFragmentCapability } from './fragment-grant'
import { getFragmentData, getFragmentDetails } from './fragment-details'
import {
  cancelNotification,
  listNotifications,
  startFragmentNotifications,
} from './fragment-notify'
import { listRevisions, revertToBefore } from './fragment-history'
import { getProvenance } from './fragment-provenance'
import { registerFragmentShareIpc } from './share/fragment-share-ipc'
import {
  appendFragmentLog,
  fragmentEvents,
  getFragment,
  isFragmentId,
  listFragments,
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
  // The page asked again for a capability the person has not allowed (orbit.permissions.request):
  // the tab re-opens the ask instead of the request dying in a dismissed badge.
  fragmentEvents.on('permission-ask', (event: FragmentPermissionAskEvent) =>
    sendToWindows('fragment:permission-ask', event),
  )

  // A fragment went away (from the desktop or from a phone): every open window drops it.
  fragmentEvents.on('removed', (event: { fragmentId: string }) => sendToWindows('fragment:removed', event))

  registerFragmentShareIpc()
  // Notifications scheduled by fragments tick while Orbit is open, mounted or not.
  startFragmentNotifications()

  ipcMain.handle('fragment:list', () => listFragments())
  ipcMain.handle('fragment:get', (_event, id: string) => getFragment(id))
  // Read-only: the record is written by Orbit's own flows, never through IPC.
  ipcMain.handle('fragment:provenance', async (_event, id: string) => {
    const manifest = await getFragment(id)
    return manifest ? getProvenance(id, manifest.createdAt) : null
  })
  // The origin of every fragment in one read: the library's source filters count them
  // together, and asking once per card would be one round trip per card.
  ipcMain.handle('fragment:provenances', async () => {
    const fragments = await listFragments()
    const pairs = await Promise.all(
      fragments.map(async (fragment) => [fragment.id, await getProvenance(fragment.id, fragment.createdAt)] as const),
    )
    return Object.fromEntries(pairs)
  })
  // Read-only numbers for the details panel (weight, data keys, token spend, origin).
  ipcMain.handle('fragment:details', (_event, id: string) => (isFragmentId(id) ? getFragmentDetails(id) : null))
  ipcMain.handle('fragment:data', (_event, id: string) => (isFragmentId(id) ? getFragmentData(id) : null))
  ipcMain.handle('fragment:history', (_event, id: string) => (isFragmentId(id) ? listRevisions(id) : []))
  // Only the person reverts, from the history dialog: the agent has no tool for it.
  ipcMain.handle('fragment:revert', (_event, id: string, revision: number) =>
    isFragmentId(id) && Number.isInteger(revision) ? revertToBefore(id, revision) : null,
  )
  ipcMain.handle('fragment:call', (_event, input: FragmentCallInput) => handleFragmentCall(input))

  // The ONLY place a capability is granted: a click of the user (see fragment-grant.ts, which the phone uses too).
  ipcMain.handle('fragment:grant', (_event, id: string, capability: string, on: boolean) => grantFragmentCapability(id, capability, on))

  // Name, pins, model and the editing chat: the person's choices, never the agent's.
  ipcMain.handle('fragment:update', (_event, id: string, patch: FragmentMetaPatch) => {
    if (!isFragmentId(id) || !patch || typeof patch !== 'object') return null
    return updateFragmentMeta(id, patch)
  })

  ipcMain.handle('fragment:remove', (_event, id: string) => deleteFragment(id))

  // The notifications this fragment scheduled (the details panel lists them; the page reads them too).
  ipcMain.handle('fragment:notifications', (_event, id: string) =>
    isFragmentId(id) ? listNotifications(id) : [],
  )
  ipcMain.handle('fragment:notification-cancel', async (_event, id: string, notificationId?: string) => {
    if (!isFragmentId(id)) return 0
    // Only the schedule changes (not the page), so nothing reloads: the callers re-read the list.
    return cancelNotification(id, typeof notificationId === 'string' ? notificationId : undefined)
  })

  // The page's console, forwarded by the tab (see fragment_logs).
  ipcMain.on('fragment:log', (_event, id: string, entry: FragmentLogEntry) => {
    if (!isFragmentId(id) || !entry || typeof entry.message !== 'string') return
    const level = LOG_LEVELS.has(entry.level) ? entry.level : 'log'
    appendFragmentLog(id, { at: Date.now(), level, message: entry.message })
  })
}
