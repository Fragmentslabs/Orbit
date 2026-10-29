import { create } from "zustand"
import type { PermissionMode } from "@shared/chat"
import { chatApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Nível de autonomia POR CHAT, no mesmo desenho do modelo por chat.
 *
 * `defaultMode` é o padrão (o último nível usado num chat novo) e também o
 * fallback de quem nunca escolheu nada — é o que as Preferências e os
 * companions veem como "modo do app". `modes` guarda a escolha de cada sessão:
 * mudar para Irrestrito num chat NÃO afrouxa os outros (antes era uma chave só,
 * `orbit-permission-mode`, e o seletor mudava o app inteiro).
 */

const DEFAULT_KEY = "orbit-permission-mode"
const STORAGE_KEY = "orbit-session-permission"
const DRAFT_KEY = "draft"

function loadDefault(): PermissionMode {
  const stored = localStorage.getItem(DEFAULT_KEY)
  return stored === "approve" || stored === "full" ? stored : "ask"
}

function isMode(value: unknown): value is PermissionMode {
  return value === "ask" || value === "approve" || value === "full"
}

function loadModes(): Record<string, PermissionMode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return {}
    const modes: Record<string, PermissionMode> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isMode(value)) modes[key] = value
    }
    return modes
  } catch {
    // prefs corrompidas → todo chat segue o padrão
    return {}
  }
}

function persistModes(modes: Record<string, PermissionMode>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(modes))
}

interface PermissionPrefsState {
  /** Padrão de um chat novo (e fallback de quem não escolheu). */
  defaultMode: PermissionMode
  /** sessionId → nível escolhido naquele chat */
  modes: Record<string, PermissionMode>
  /** Troca feita nesta tela: ir para Irrestrito também libera os pedidos já
   *  abertos no chat alvo. `null`/ausente = chat novo (draft). */
  setMode: (sessionId: string | null | undefined, mode: PermissionMode) => void
  /** Troca que veio de fora (o celular): só muda o nível daquele chat. O
   *  rascunho não viaja — "draft" no celular é outro chat. */
  applyRemoteMode: (sessionId: string, mode: PermissionMode) => void
  /** Padrão vindo de outro aparelho (preferências do app). */
  setDefaultMode: (mode: PermissionMode) => void
  /** Move a escolha do rascunho para a sessão recém-criada. */
  adopt: (sessionId: string) => void
  clear: (sessionId: string) => void
}

/**
 * Ao mudar para Irrestrito, os pedidos de permissão que já estão abertos no
 * chat alvo são aprovados (pelo turno) — o usuário acabou de dizer que não
 * quer mais ser perguntado. Os de outros chats ficam: quem mudou o nível não
 * os viu. Pedidos que perguntam sempre (ex.: remover worktree) também ficam.
 */
function liberarPedidos(sessionId: string | null | undefined) {
  if (!sessionId) return
  const pendentes = useSessionStore.getState().pendingAsks[sessionId] ?? []
  for (const ask of pendentes) {
    if (ask.kind !== "permission" || ask.claim?.alwaysAsk) continue
    void chatApi.askReply(ask.requestId, "allow")
  }
}

export const usePermissionPrefs = create<PermissionPrefsState>((set, get) => ({
  defaultMode: loadDefault(),
  modes: loadModes(),

  setMode: (sessionId, mode) => {
    const key = sessionId ?? DRAFT_KEY
    const anterior = get().modes[key] ?? get().defaultMode
    const modes = { ...get().modes, [key]: mode }
    persistModes(modes)

    // Chat novo: o nível escolhido também vira o padrão, para o próximo chat
    // novo já abrir nele (mesmo contrato do modelo por chat).
    if (sessionId) {
      set({ modes })
    } else {
      localStorage.setItem(DEFAULT_KEY, mode)
      set({ modes, defaultMode: mode })
    }

    if (mode === "full" && anterior !== "full") liberarPedidos(sessionId)
  },

  applyRemoteMode: (sessionId, mode) => {
    if (!sessionId || !isMode(mode)) return
    const modes = { ...get().modes, [sessionId]: mode }
    persistModes(modes)
    set({ modes })
  },

  setDefaultMode: (mode) => {
    if (!isMode(mode)) return
    localStorage.setItem(DEFAULT_KEY, mode)
    set({ defaultMode: mode })
  },

  adopt: (sessionId) => {
    const { modes } = get()
    if (!(DRAFT_KEY in modes)) return
    const next = { ...modes, [sessionId]: modes[DRAFT_KEY] }
    delete next[DRAFT_KEY]
    persistModes(next)
    set({ modes: next })
  },

  clear: (sessionId) => {
    const modes = { ...get().modes }
    delete modes[sessionId]
    persistModes(modes)
    set({ modes })
  },
}))

/** Nível efetivo do chat: override da sessão > padrão do app. */
export function permissionFor(sessionId?: string | null): PermissionMode {
  const { modes, defaultMode } = usePermissionPrefs.getState()
  return modes[sessionId ?? DRAFT_KEY] ?? defaultMode
}

export function usePermissionMode(sessionId?: string | null): PermissionMode {
  const key = sessionId ?? DRAFT_KEY
  return usePermissionPrefs((s) => s.modes[key] ?? s.defaultMode)
}
