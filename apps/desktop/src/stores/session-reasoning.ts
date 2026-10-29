import { useCallback } from "react"
import { create } from "zustand"

import type { ModelReasoningPref } from "@shared/companion"
import { useReasoningPrefsStore } from "@/src/stores/reasoning-prefs"

/**
 * Thinking POR CHAT (toggle + variante), no mesmo desenho do modelo por chat:
 * `overrides` guarda a escolha de cada sessão, o chat novo usa a chave DRAFT
 * até o primeiro envio (adopt) e, sem override, vale o nível POR MODELO das
 * Preferências (reasoning-prefs) — que continua sendo o default.
 *
 * Antes o nível era só por modelo: escolher "alto" num chat mudava o thinking
 * de TODOS os chats daquele modelo. Agora a troca no seletor do chat grava
 * aqui; o thinking das Preferências (ModelThinkingMenu) segue sendo o default
 * de quando o chat não escolheu nada.
 */

const STORAGE_KEY = "orbit-session-reasoning"
const DRAFT_KEY = "draft"

type ReasoningMap = Record<string, ModelReasoningPref>

function load(): ReasoningMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return {}
    const map: ReasoningMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue
      const pref = value as Partial<ModelReasoningPref>
      if (typeof pref.enabled !== "boolean") continue
      map[key] = {
        enabled: pref.enabled,
        ...(typeof pref.variantId === "string" ? { variantId: pref.variantId } : {}),
      }
    }
    return map
  } catch {
    // prefs corrompidas → sem override (todo chat segue o nível do modelo)
    return {}
  }
}

function persist(bySession: ReasoningMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bySession))
}

interface SessionReasoningState {
  overrides: ReasoningMap
  /** Escolha feita no chat (ou no draft): vale só para ele. */
  setPref: (sessionId: string | null | undefined, pref: ModelReasoningPref) => void
  /** Transfere a escolha do rascunho para a sessão recém-criada; sem escolha
   *  no draft, fixa o nível efetivamente usado (o do modelo), para o chat que
   *  já começou não mudar quando o default mudar. */
  adopt: (sessionId: string, fallback?: ModelReasoningPref) => void
  clear: (sessionId: string) => void
}

export const useSessionReasoning = create<SessionReasoningState>((set, get) => ({
  overrides: load(),

  setPref: (sessionId, pref) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides, [key]: pref }
    persist(overrides)
    set({ overrides })
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
    persist(overrides)
    set({ overrides })
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    persist(overrides)
    set({ overrides })
  },
}))

/** Nível efetivo de um chat: override da sessão > nível do modelo (Preferências). */
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

  // A mesma referência nos dois lados evita re-render à toa quando só o outro
  // store mudou: o override, quando existe, é a única fonte.
  const pref = override ?? modelPref

  const update = useCallback(
    (next: ModelReasoningPref) => {
      setPref(sessionId ?? null, next)
    },
    [sessionId, setPref],
  )

  return { enabled: pref?.enabled ?? false, variantId: pref?.variantId, update }
}
