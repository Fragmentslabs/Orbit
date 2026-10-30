import { create } from "zustand"
import { normalizeAppSettings, type AppSettings } from "@shared/app-settings"
import { appSettingsApi } from "@/src/lib/ipc"

/**
 * General app settings (Preferences → General and Browser). The renderer is
 * the source of truth: it keeps them in localStorage and pushes a copy to main on every
 * change — it is that copy the engine, the automatic archiving and the browser read.
 */

const STORAGE_KEY = "orbit-app-settings"

function load(): AppSettings {
  try {
    return normalizeAppSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"))
  } catch {
    return normalizeAppSettings({})
  }
}

interface AppSettingsState {
  settings: AppSettings
  update: (patch: Partial<Omit<AppSettings, "browser">> & { browser?: Partial<AppSettings["browser"]> }) => void
}

export const useAppSettings = create<AppSettingsState>((set, get) => ({
  settings: load(),
  update: (patch) => {
    const current = get().settings
    const settings = normalizeAppSettings({
      ...current,
      ...patch,
      browser: { ...current.browser, ...patch.browser },
    })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    set({ settings })
    appSettingsApi.sync(settings)
  },
}))

/** Shortcut to read a setting (reactive). */
export function useSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return useAppSettings((s) => s.settings[key])
}

// On startup main may hold the copy from an earlier version — or none.
if (typeof window !== "undefined" && window.ipcRenderer) {
  appSettingsApi.sync(useAppSettings.getState().settings)

  // Main also writes: the agent's `set_user_name` tool writes the name into the
  // same field as the Preference. We apply it in the store and in localStorage WITHOUT
  // sending it back to main — the echo of what the renderer sent arrives identical and is
  // ignored by the comparison.
  appSettingsApi.onChange((settings) => {
    const current = useAppSettings.getState().settings
    if (JSON.stringify(current) === JSON.stringify(settings)) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    useAppSettings.setState({ settings })
  })
}
