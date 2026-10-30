import type { AppPreferences } from '@orbit/shared'
import { useConnectionStore } from './connection-store'
import { useModelModePrefs, type ActiveModeDefaults } from './model-mode-prefs'
import { usePermissionPrefs } from './permission-prefs'
import { useSettingsStore } from './settings-store'

/**
 * App preferences mirrored with the desktop: mode defaults per type of
 * chat, permission mode and automatic folder creation.
 *
 * The desktop is the source of truth (they live in the renderer's localStorage). On
 * connection the phone pulls the snapshot and adopts it — before, it was born with its own
 * defaults, ignoring what was configured on the desktop. After that the
 * link goes both ways: a change here goes through `prefs:set` and comes back through
 * `prefs:change`, which also arrives when the change was made on the desktop.
 *
 * It lives outside the stores so as not to create an import cycle (same reason as
 * mode-sync).
 */

// Last known snapshot — avoids echo: applying what came from the desktop triggers
// the local subscribes, and without this the push would send the same value back there.
let last = ''

function snapshot(): AppPreferences {
  const modes = useModelModePrefs.getState()
  return {
    chatModes: modes.chatActiveModes,
    codeModes: modes.codeActiveModes,
    // App default (new chat); the level of each chat travels in session-prefs.
    permissionMode: usePermissionPrefs.getState().defaultMode,
    autoCreateFolders: useSettingsStore.getState().autoCreateFolders,
  }
}

// It only starts pushing after adopting the desktop snapshot: a push before
// that would send the local prefs of the phone over the ones from there right on the first
// pairing — the opposite of what is expected.
let inscrito = false

function inscrever(): void {
  if (inscrito) return
  inscrito = true
  useModelModePrefs.subscribe(pushAppPreferences)
  usePermissionPrefs.subscribe(pushAppPreferences)
  // This store changes for many reasons (catalog, models); the push compares the
  // serialized snapshot, so it only leaves the machine when one of the prefs changes.
  useSettingsStore.subscribe(pushAppPreferences)
}

function aplicar(prefs: AppPreferences): void {
  if (!prefs || typeof prefs !== 'object') return
  last = JSON.stringify(prefs)

  const modes = useModelModePrefs.getState()
  for (const [key, value] of Object.entries(prefs.chatModes ?? {})) {
    const k = key as keyof ActiveModeDefaults
    if (modes.chatActiveModes[k] !== value) modes.setChatActiveMode(k, value as boolean)
  }
  for (const [key, value] of Object.entries(prefs.codeModes ?? {})) {
    const k = key as keyof ActiveModeDefaults
    if (modes.codeActiveModes[k] !== value) modes.setCodeActiveMode(k, value as boolean)
  }
  if (prefs.permissionMode && prefs.permissionMode !== usePermissionPrefs.getState().defaultMode) {
    usePermissionPrefs.getState().setDefaultMode(prefs.permissionMode)
  }
  if (
    typeof prefs.autoCreateFolders === 'boolean' &&
    prefs.autoCreateFolders !== useSettingsStore.getState().autoCreateFolders
  ) {
    void useSettingsStore.getState().setAutoCreateFolders(prefs.autoCreateFolders)
  }

  inscrever()
}

/** Change made here → desktop, which applies it and sends it back to all companions. */
export function pushAppPreferences(): void {
  const prefs = snapshot()
  const serialized = JSON.stringify(prefs)
  if (serialized === last) return
  last = serialized
  const { wsClient } = useConnectionStore.getState()
  void wsClient.send({ type: 'prefs:set', prefs }).catch(() => {})
}

/** Desktop snapshot on connection — the prefs from there rule. */
export async function hydrateAppPreferences(): Promise<void> {
  const { wsClient } = useConnectionStore.getState()
  try {
    const res = await wsClient.send({ type: 'prefs:get' })
    // null = the desktop has not published yet (renderer starting up); the 'prefs:change'
    // arrives right after and resolves it.
    if (res.ok && res.data) aplicar(res.data as AppPreferences)
  } catch {
    // Offline: goes on with what is stored on the device.
  }
}

/** Event from the desktop (changed there, or on another paired device). */
export function applyAppPreferences(prefs: AppPreferences): void {
  aplicar(prefs)
}
