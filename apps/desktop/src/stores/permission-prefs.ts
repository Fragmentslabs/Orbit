import { create } from "zustand"
import type { PermissionMode } from "@shared/chat"
import { chatApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"

const MODE_KEY = "orbit-permission-mode"

function loadMode(): PermissionMode {
  const stored = localStorage.getItem(MODE_KEY)
  return stored === "approve" || stored === "full" ? stored : "ask"
}

interface PermissionPrefsState {
  mode: PermissionMode
  /** Troca feita nesta tela: ir para Irrestrito também libera os pedidos já abertos no chat da tela. */
  setMode: (mode: PermissionMode) => void
  /** Troca que veio de fora (o celular): só muda o modo. */
  applyRemoteMode: (mode: PermissionMode) => void
}

/** Chat que está na tela: o ativo do modo em que o app está (chat ou código). */
function sessaoNaTela(): string | undefined {
  let modo: "chat" | "code" = "chat"
  try {
    if (JSON.parse(localStorage.getItem("orbit-default-mode") ?? '"chat"') === "code") modo = "code"
  } catch {
    // modo corrompido: fica no chat
  }
  return useSessionStore.getState().activeIds[modo] ?? undefined
}

/**
 * Ao mudar para Irrestrito, os pedidos de permissão que já estão abertos no
 * chat da tela são aprovados (pelo turno) — o usuário acabou de dizer que
 * não quer mais ser perguntado. Os de chats que não estão à vista ficam: quem
 * mudou o modo não os viu. Pedidos que perguntam sempre (ex.: remover
 * worktree) também ficam.
 */
function liberarPedidosDaTela() {
  const sessionId = sessaoNaTela()
  if (!sessionId) return
  const pendentes = useSessionStore.getState().pendingAsks[sessionId] ?? []
  for (const ask of pendentes) {
    if (ask.kind !== "permission" || ask.claim?.alwaysAsk) continue
    void chatApi.askReply(ask.requestId, "allow")
  }
}

export const usePermissionPrefs = create<PermissionPrefsState>((set, get) => ({
  mode: loadMode(),
  setMode: (mode) => {
    const anterior = get().mode
    localStorage.setItem(MODE_KEY, mode)
    set({ mode })
    if (mode === "full" && anterior !== "full") liberarPedidosDaTela()
  },
  applyRemoteMode: (mode) => {
    localStorage.setItem(MODE_KEY, mode)
    set({ mode })
  },
}))
