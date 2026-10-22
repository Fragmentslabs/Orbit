import { create } from "zustand"

/**
 * Servidores MCP por conversa.
 *
 * As ferramentas não têm liga/desliga: elas existem sempre que há servidor
 * ligado no app. O que muda de conversa para conversa é QUAIS servidores
 * entram no contexto — daí este store ser só a seleção, e morar separado dos
 * overrides de modo (que guardam booleano e não serviriam para um recorte).
 *
 * - `null`   = todos os servidores ligados no app
 * - `[...]`  = só esses (lista vazia = nenhum nesta conversa)
 *
 * Desligar um SERVIDOR de verdade é na página MCP & Skills (`config.enabled`),
 * que vale para todas as conversas. Aqui é só o recorte local.
 */

const STORAGE_KEY = "orbit-session-tools"
/** Rascunho por aparelho, como em mode-overrides */
const DRAFT_KEY = "draft"

type ToolsMap = Record<string, string[] | null>

function toStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === "string")
}

function load(): ToolsMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return {}
    const map: ToolsMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      // Formato antigo (`{ enabled, servers }`), de quando o controle tinha um
      // interruptor geral: aproveita só o recorte e descarta o booleano.
      if (Array.isArray(value)) map[key] = toStringList(value)
      else if (value && typeof value === "object" && "servers" in value) {
        map[key] = toStringList((value as { servers?: unknown }).servers)
      }
    }
    return map
  } catch {
    // prefs corrompidas → sem recorte (todos os servidores ligados)
    return {}
  }
}

function persist(bySession: ToolsMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bySession))
}

interface SessionToolsState {
  bySession: ToolsMap
  /** Recorte explícito; `null` volta para "todos os ligados no app". */
  setServers: (sessionId: string | null | undefined, servers: string[] | null) => void
  /** Transfere a preferência do rascunho para a sessão recém-criada */
  adopt: (sessionId: string) => void
}

export const useSessionTools = create<SessionToolsState>((set) => ({
  bySession: load(),

  setServers: (sessionId, servers) => {
    const key = sessionId ?? DRAFT_KEY
    set((state) => {
      const bySession = { ...state.bySession, [key]: servers }
      persist(bySession)
      return { bySession }
    })
  },

  adopt: (sessionId) => {
    set((state) => {
      if (!(DRAFT_KEY in state.bySession)) return {}
      const bySession = { ...state.bySession, [sessionId]: state.bySession[DRAFT_KEY] }
      delete bySession[DRAFT_KEY]
      persist(bySession)
      return { bySession }
    })
  },
}))

/** `null` = todos os servidores ligados no app. */
export function useToolsServers(sessionId: string | null | undefined): string[] | null {
  return useSessionTools((s) => s.bySession[sessionId ?? DRAFT_KEY] ?? null)
}
