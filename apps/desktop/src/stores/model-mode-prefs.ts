import { create } from "zustand"

const DEFAULT_MODE_KEY = "orbit-default-mode"
const CHAT_MODEL_KEY = "orbit-chat-model"
const CODE_MODEL_KEY = "orbit-code-model"
const SUBAGENT_MODEL_KEY = "orbit-subagent-model"
const ORCHESTRA_MODEL_KEY = "orbit-orchestra-model"
const CHAT_ACTIVE_MODES_KEY = "orbit-chat-active-modes"
const CODE_ACTIVE_MODES_KEY = "orbit-code-active-modes"
const CHAT_PERM_MODE_KEY = "orbit-chat-perm-mode"
const CODE_PERM_MODE_KEY = "orbit-code-perm-mode"
const AUTO_FOLDERS_KEY = "orbit-auto-folders"

export interface DefaultModel {
  providerId: string
  modelId: string
}

export interface ActiveModeDefaults {
  simple: boolean
  brain: boolean
  thinking: boolean
  search: boolean
  browser: boolean
  plan: boolean
  subagents: boolean
  orchestra: boolean
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const DEFAULT_CHAT_MODES: ActiveModeDefaults = {
  simple: false,
  brain: true,
  thinking: false,
  search: false,
  browser: false,
  plan: false,
  subagents: false,
  orchestra: false,
}

const DEFAULT_CODE_MODES: ActiveModeDefaults = {
  simple: false,
  brain: true,
  thinking: false,
  search: false,
  browser: false,
  plan: false,
  subagents: false,
  orchestra: false,
}

interface ModelModePrefsState {
  defaultMode: "chat" | "code"
  chatModel: DefaultModel | null
  codeModel: DefaultModel | null
  subagentModel: DefaultModel | null
  orchestraModel: DefaultModel | null
  chatActiveModes: ActiveModeDefaults
  codeActiveModes: ActiveModeDefaults
  chatPermissionMode: "ask" | "approve" | "full"
  codePermissionMode: "ask" | "approve" | "full"
  autoCreateFolders: boolean

  setDefaultMode: (mode: "chat" | "code") => void
  setChatModel: (model: DefaultModel | null) => void
  setCodeModel: (model: DefaultModel | null) => void
  setSubagentModel: (model: DefaultModel | null) => void
  setOrchestraModel: (model: DefaultModel | null) => void
  setChatActiveMode: (key: keyof ActiveModeDefaults, value: boolean) => void
  setCodeActiveMode: (key: keyof ActiveModeDefaults, value: boolean) => void
  setChatPermissionMode: (mode: "ask" | "approve" | "full") => void
  setCodePermissionMode: (mode: "ask" | "approve" | "full") => void
  setAutoCreateFolders: (value: boolean) => void
}

export const useModelModePrefs = create<ModelModePrefsState>((set) => ({
  defaultMode: loadJson<"chat" | "code">(DEFAULT_MODE_KEY, "chat"),
  chatModel: loadJson<DefaultModel | null>(CHAT_MODEL_KEY, null),
  codeModel: loadJson<DefaultModel | null>(CODE_MODEL_KEY, null),
  subagentModel: loadJson<DefaultModel | null>(SUBAGENT_MODEL_KEY, null),
  orchestraModel: loadJson<DefaultModel | null>(ORCHESTRA_MODEL_KEY, null),
  chatActiveModes: loadJson<ActiveModeDefaults>(CHAT_ACTIVE_MODES_KEY, DEFAULT_CHAT_MODES),
  codeActiveModes: loadJson<ActiveModeDefaults>(CODE_ACTIVE_MODES_KEY, DEFAULT_CODE_MODES),
  chatPermissionMode: loadJson<"ask" | "approve" | "full">(CHAT_PERM_MODE_KEY, "ask"),
  codePermissionMode: loadJson<"ask" | "approve" | "full">(CODE_PERM_MODE_KEY, "approve"),
  autoCreateFolders: loadJson<boolean>(AUTO_FOLDERS_KEY, false),

  setDefaultMode: (mode) => {
    localStorage.setItem(DEFAULT_MODE_KEY, JSON.stringify(mode))
    set({ defaultMode: mode })
  },
  setChatModel: (model) => {
    if (model) localStorage.setItem(CHAT_MODEL_KEY, JSON.stringify(model))
    else localStorage.removeItem(CHAT_MODEL_KEY)
    set({ chatModel: model })
  },
  setCodeModel: (model) => {
    if (model) localStorage.setItem(CODE_MODEL_KEY, JSON.stringify(model))
    else localStorage.removeItem(CODE_MODEL_KEY)
    set({ codeModel: model })
  },
  setSubagentModel: (model) => {
    if (model) localStorage.setItem(SUBAGENT_MODEL_KEY, JSON.stringify(model))
    else localStorage.removeItem(SUBAGENT_MODEL_KEY)
    set({ subagentModel: model })
  },
  setOrchestraModel: (model) => {
    if (model) localStorage.setItem(ORCHESTRA_MODEL_KEY, JSON.stringify(model))
    else localStorage.removeItem(ORCHESTRA_MODEL_KEY)
    set({ orchestraModel: model })
  },
  setChatActiveMode: (key, value) => {
    set((state) => {
      const next = { ...state.chatActiveModes, [key]: value }
      localStorage.setItem(CHAT_ACTIVE_MODES_KEY, JSON.stringify(next))
      return { chatActiveModes: next }
    })
  },
  setCodeActiveMode: (key, value) => {
    set((state) => {
      const next = { ...state.codeActiveModes, [key]: value }
      localStorage.setItem(CODE_ACTIVE_MODES_KEY, JSON.stringify(next))
      return { codeActiveModes: next }
    })
  },
  setChatPermissionMode: (mode) => {
    localStorage.setItem(CHAT_PERM_MODE_KEY, JSON.stringify(mode))
    set({ chatPermissionMode: mode })
  },
  setCodePermissionMode: (mode) => {
    localStorage.setItem(CODE_PERM_MODE_KEY, JSON.stringify(mode))
    set({ codePermissionMode: mode })
  },
  setAutoCreateFolders: (value) => {
    localStorage.setItem(AUTO_FOLDERS_KEY, JSON.stringify(value))
    set({ autoCreateFolders: value })
  },
}))
