import type { SessionPrefsSnapshot } from "@shared/companion"
import { sessionPrefsApi } from "@/src/lib/ipc"
import { useSessionReasoning } from "@/src/stores/session-reasoning"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"

/**
 * Thinking e autonomia POR CHAT com os companions (mobile), no mesmo desenho
 * do session-models/session-modes: o renderer é a fonte da verdade (as escolhas
 * vivem no localStorage dele), empurra o snapshot a cada mudança e aplica o que
 * foi escolhido no celular (WS 'session:prefs-select').
 *
 * A chave 'draft' fica fora: "chat novo" no desktop é outro chat que o "chat
 * novo" no celular — a mesma regra dos modos.
 */

const DRAFT_KEY = "draft"

function withoutDraft<T>(bySession: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(bySession).filter(([key]) => key !== DRAFT_KEY))
}

function snapshot(): SessionPrefsSnapshot {
  return {
    reasoning: withoutDraft(useSessionReasoning.getState().overrides),
    permission: withoutDraft(usePermissionPrefs.getState().modes),
  }
}

// Dedup: os dois stores mudam também pelo que vem do celular — sem comparar,
// cada aplicação voltaria como se fosse novidade.
let lastPushed = ""

function push() {
  const prefs = snapshot()
  const serialized = JSON.stringify(prefs)
  if (serialized === lastPushed) return
  lastPushed = serialized
  sessionPrefsApi.sync(prefs)
}

function applyRemote(data: {
  sessionId?: string | null
  reasoning?: { enabled: boolean; variantId?: string }
  permission?: "ask" | "approve" | "full"
}) {
  // Sem sessão é o rascunho do OUTRO aparelho: não mexe no daqui.
  if (!data?.sessionId) return
  if (data.permission) {
    usePermissionPrefs.getState().applyRemoteMode(data.sessionId, data.permission)
  }
  if (data.reasoning && typeof data.reasoning.enabled === "boolean") {
    useSessionReasoning.getState().setPref(data.sessionId, {
      enabled: data.reasoning.enabled,
      ...(data.reasoning.variantId ? { variantId: data.reasoning.variantId } : {}),
    })
  }
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  // Estado inicial: depois de um reload do renderer o cache do main precisa
  // ser repopulado, senão o mobile conecta e recebe um snapshot vazio.
  push()
  useSessionReasoning.subscribe(push)
  usePermissionPrefs.subscribe(push)
  sessionPrefsApi.onSelect(applyRemote)
}
