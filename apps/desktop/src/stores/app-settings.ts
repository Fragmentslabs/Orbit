import { create } from "zustand"
import { normalizeAppSettings, type AppSettings } from "@shared/app-settings"
import { appSettingsApi } from "@/src/lib/ipc"

/**
 * Configurações gerais do app (Preferências → Geral e Navegador). O renderer é
 * a fonte da verdade: guarda no localStorage e empurra uma cópia ao main a cada
 * mudança — é ela que o engine, o arquivamento automático e o navegador leem.
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

/** Atalho para ler uma configuração (reativo). */
export function useSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return useAppSettings((s) => s.settings[key])
}

// Na abertura o main pode estar com a cópia de uma versão anterior — ou nenhuma.
if (typeof window !== "undefined" && window.ipcRenderer) {
  appSettingsApi.sync(useAppSettings.getState().settings)
}
