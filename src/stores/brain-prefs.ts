import { create } from "zustand"

/**
 * Preferência do modo Brain (memória persistente): ativo por padrão em todo
 * chat, nos dois modos; o usuário pode desativar por chat. Só as desativações
 * são persistidas (localStorage) — ausência de override = ativo.
 *
 * Chats novos (sem sessão) usam a chave "draft"; quando a sessão é criada no
 * primeiro envio, o session-store chama adopt() para transferir o override.
 *
 * Preferências GERAIS (não por sessão):
 * - chatContext / codeContext: injeção de contexto no prompt
 *   "off" = desligado
 *   "all" = ligado em todos chats
 *   "memory" = ligado só em chats com modo memória ativo
 */

export type BrainContextMode = "off" | "all" | "memory"

const STORAGE_KEY = "orbit-brain-prefs"
const DRAFT_KEY = "draft"
const CHAT_CONTEXT_KEY = "orbit-chat-brain-context"
const CODE_CONTEXT_KEY = "orbit-code-brain-context"

function load(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // prefs corrompidas — volta ao default (tudo ativo)
  }
  return {}
}

function persist(overrides: Record<string, boolean>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

function loadContext(key: string, fallback: BrainContextMode): BrainContextMode {
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) {
      const v = JSON.parse(raw) as BrainContextMode
      if (v === "off" || v === "all" || v === "memory") return v
    }
  } catch {
    // ignore
  }
  return fallback
}

interface BrainPrefsState {
  overrides: Record<string, boolean>
  chatContext: BrainContextMode
  codeContext: BrainContextMode
  setEnabled: (sessionId: string | null | undefined, enabled: boolean) => void
  setChatContext: (mode: BrainContextMode) => void
  setCodeContext: (mode: BrainContextMode) => void
  /** Transfere o override do rascunho para a sessão recém-criada */
  adopt: (sessionId: string) => void
}

export const useBrainPrefs = create<BrainPrefsState>((set, get) => ({
  overrides: load(),
  chatContext: loadContext(CHAT_CONTEXT_KEY, "all"),
  codeContext: loadContext(CODE_CONTEXT_KEY, "all"),
  setEnabled: (sessionId, enabled) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides }
    if (enabled) delete overrides[key]
    else overrides[key] = false
    persist(overrides)
    set({ overrides })
  },
  setChatContext: (mode) => {
    localStorage.setItem(CHAT_CONTEXT_KEY, JSON.stringify(mode))
    set({ chatContext: mode })
  },
  setCodeContext: (mode) => {
    localStorage.setItem(CODE_CONTEXT_KEY, JSON.stringify(mode))
    set({ codeContext: mode })
  },
  adopt: (sessionId) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] === undefined) return
    overrides[sessionId] = overrides[DRAFT_KEY]
    delete overrides[DRAFT_KEY]
    persist(overrides)
    set({ overrides })
  },
}))

export function useBrainEnabled(sessionId?: string | null): boolean {
  return useBrainPrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? true)
}

/** Leitura fora de componentes React (callbacks de envio) */
export function brainEnabledFor(sessionId?: string | null): boolean {
  return useBrainPrefs.getState().overrides[sessionId ?? DRAFT_KEY] ?? true
}

export function useChatContext(): BrainContextMode {
  return useBrainPrefs((s) => s.chatContext)
}

export function useCodeContext(): BrainContextMode {
  return useBrainPrefs((s) => s.codeContext)
}
