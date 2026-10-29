import { create } from 'zustand'
import type { ModelReasoningPref } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from '~/stores/connection-store'
import { useReasoningPrefsStore } from '~/stores/reasoning-prefs'

/**
 * Thinking POR CHAT (mesmo padrão do modelo e dos modos por chat). `overrides`
 * guarda a escolha de cada sessão; o chat novo usa a chave DRAFT até a criação
 * da sessão (adopt) e, sem override, vale o nível POR MODELO que o desktop
 * mantém (reasoning-prefs) — o default das Preferências.
 *
 * O desktop é a fonte da verdade: aplica o que o celular escolhe (WS
 * 'session:prefs-select') e devolve o mapa inteiro pelo 'session:prefs-change'.
 */

const STORAGE_KEY = 'orbit_session_reasoning'
export const DRAFT_KEY = 'draft'

export type SessionReasoningMap = Record<string, ModelReasoningPref>

interface SessionReasoningState {
  overrides: SessionReasoningMap
  hydrated: boolean
  hydrate: () => Promise<void>
  /** Snapshot do desktop (connect) ou evento ao vivo. No connect só preenche
   *  o que falta (escolha feita aqui vence); no evento ao vivo ele substitui. */
  applySync: (remote: SessionReasoningMap, authoritative?: boolean) => void
  setPref: (sessionId: string | null | undefined, pref: ModelReasoningPref) => void
  adopt: (sessionId: string, fallback?: ModelReasoningPref) => void
  clear: (sessionId: string) => void
}

function normalizar(map: unknown): SessionReasoningMap {
  const out: SessionReasoningMap = {}
  if (!map || typeof map !== 'object') return out
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    const pref = value as Partial<ModelReasoningPref> | null
    if (!pref || typeof pref.enabled !== 'boolean') continue
    out[key] = {
      enabled: pref.enabled,
      ...(typeof pref.variantId === 'string' ? { variantId: pref.variantId } : {}),
    }
  }
  return out
}

export const useSessionReasoning = create<SessionReasoningState>((set, get) => ({
  overrides: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) set({ overrides: normalizar(JSON.parse(raw)) })
    } catch {
      // prefs corrompidas — todo chat segue o nível do modelo
    }
    set({ hydrated: true })
  },

  applySync: (remote, authoritative = false) => {
    const incoming = normalizar(remote)
    if (Object.keys(incoming).length === 0 && !authoritative) return

    let next: SessionReasoningMap
    if (authoritative) {
      // O mapa do desktop substitui o local — assim um nível que voltou a
      // seguir o default lá (chave removida) também volta aqui.
      next = { ...incoming }
      const draft = get().overrides[DRAFT_KEY]
      if (draft !== undefined) next[DRAFT_KEY] = draft
    } else {
      next = { ...get().overrides }
      let changed = false
      for (const [key, pref] of Object.entries(incoming)) {
        if (key === DRAFT_KEY || next[key] !== undefined) continue
        next[key] = pref
        changed = true
      }
      if (!changed) return
    }

    void Storage.setItem(STORAGE_KEY, JSON.stringify(next))
    set({ overrides: next, hydrated: true })
  },

  setPref: (sessionId, pref) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides, [key]: pref }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })

    // Chat novo é por aparelho: não viaja. Com sessão, o desktop aplica no
    // renderer dele (fonte da verdade) e devolve o snapshot a todos.
    if (!sessionId) return
    const { wsClient } = useConnectionStore.getState()
    try {
      void wsClient.send({ type: 'session:prefs-select', sessionId, reasoning: pref }).catch(() => {})
    } catch {
      // Offline: o envio leva o thinking da sessão no próprio turno.
    }
  },

  adopt: (sessionId, fallback) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] !== undefined) {
      overrides[sessionId] = overrides[DRAFT_KEY]
      delete overrides[DRAFT_KEY]
    } else if (fallback) {
      overrides[sessionId] = fallback
    } else {
      return
    }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },
}))

/** Nível efetivo do chat: override da sessão > nível do modelo (desktop). */
export function sessionReasoningFor(
  sessionId: string | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelReasoningPref | undefined {
  const override = useSessionReasoning.getState().overrides[sessionId ?? DRAFT_KEY]
  if (override) return override
  if (!providerId || !modelId) return undefined
  return useReasoningPrefsStore.getState().prefs[`${providerId}/${modelId}`]
}

export function useSessionReasoningPref(
  sessionId: string | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
) {
  const key = sessionId ?? DRAFT_KEY
  const override = useSessionReasoning((s) => s.overrides[key])
  const modelPref = useReasoningPrefsStore((s) =>
    providerId && modelId ? s.prefs[`${providerId}/${modelId}`] : undefined,
  )
  const setPref = useSessionReasoning((s) => s.setPref)
  const hydrate = useSessionReasoning((s) => s.hydrate)
  const hydrated = useSessionReasoning((s) => s.hydrated)

  const pref = override ?? modelPref

  return {
    enabled: pref?.enabled ?? false,
    variantId: pref?.variantId,
    update: (next: ModelReasoningPref) => setPref(sessionId ?? null, next),
    hydrate,
    hydrated,
  }
}
