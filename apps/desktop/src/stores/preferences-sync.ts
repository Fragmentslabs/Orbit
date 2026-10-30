import type { AppPreferences } from "@shared/companion"
import { appPreferencesApi } from "@/src/lib/ipc"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"

/**
 * App preferences with the companions: mode defaults per chat type,
 * permission mode and automatic folder creation.
 *
 * Before, each app kept its own. The companion's `/api/preferences` existed,
 * but it was a parallel store nobody on the desktop read — touching the phone changed
 * nothing here, and the phone was born with its own defaults instead of the
 * desktop's. Here it is the same design as worker-config-sync: the renderer is the source
 * of truth (the prefs live in its localStorage), pushes on every change and
 * applies whatever comes from the phone.
 */

function snapshot(): AppPreferences {
  const modes = useModelModePrefs.getState()
  return {
    chatModes: modes.chatActiveModes,
    codeModes: modes.codeActiveModes,
    // The app default (new chat); each chat's level travels in session-prefs.
    permissionMode: usePermissionPrefs.getState().defaultMode,
    autoCreateFolders: modes.autoCreateFolders,
  }
}

// Both stores change for more than these prefs (model per mode, for
// example): without comparing, every switch would become a pointless broadcast. It is also what
// prevents the echo — applying what came from the phone generates the same snapshot.
let lastPushed = ""

function push() {
  const prefs = snapshot()
  const serialized = JSON.stringify(prefs)
  if (serialized === lastPushed) return
  lastPushed = serialized
  appPreferencesApi.sync(prefs)
}

function apply(prefs: AppPreferences) {
  if (!prefs || typeof prefs !== "object") return
  // Marks it as already sent BEFORE applying: the push fired by the subscribes
  // would see exactly this value and go back to the phone as if it were new.
  lastPushed = JSON.stringify(prefs)

  const modes = useModelModePrefs.getState()
  for (const [key, value] of Object.entries(prefs.chatModes ?? {})) {
    if (modes.chatActiveModes[key as keyof typeof modes.chatActiveModes] !== value) {
      modes.setChatActiveMode(key as keyof typeof modes.chatActiveModes, value as boolean)
    }
  }
  for (const [key, value] of Object.entries(prefs.codeModes ?? {})) {
    if (modes.codeActiveModes[key as keyof typeof modes.codeActiveModes] !== value) {
      modes.setCodeActiveMode(key as keyof typeof modes.codeActiveModes, value as boolean)
    }
  }
  if (typeof prefs.autoCreateFolders === "boolean" && prefs.autoCreateFolders !== modes.autoCreateFolders) {
    modes.setAutoCreateFolders(prefs.autoCreateFolders)
  }
  if (prefs.permissionMode && prefs.permissionMode !== usePermissionPrefs.getState().defaultMode) {
    // App preference coming from the phone: it becomes the new chat default. The
    // level of each chat arrives through 'session:prefs-select', with a session.
    usePermissionPrefs.getState().setDefaultMode(prefs.permissionMode)
  }
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  push()
  useModelModePrefs.subscribe(push)
  usePermissionPrefs.subscribe(push)
  appPreferencesApi.onSet(apply)
}
