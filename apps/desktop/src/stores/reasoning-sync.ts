import type { ModelReasoningPref, ReasoningPrefsMap } from "@shared/companion"
import { reasoningApi } from "@/src/lib/ipc"
import { useReasoningPrefsStore } from "@/src/stores/reasoning-prefs"

/**
 * Thinking por modelo com os companions (mobile), no mesmo desenho do
 * worker-config-sync: o renderer é a fonte da verdade (as prefs vivem no
 * localStorage dele), empurra o mapa inteiro a cada mudança e aplica os
 * toggles que chegam do celular (WS 'reasoning:select').
 */

function snapshot(): ReasoningPrefsMap {
  return useReasoningPrefsStore.getState().prefs
}

// O store de reasoning só muda por estas prefs, mas a dedup também é o que
// impede o eco — aplicar o que veio do celular gera o mesmo snapshot.
let lastPushed = ""

function push() {
  const prefs = snapshot()
  const serialized = JSON.stringify(prefs)
  if (serialized === lastPushed) return
  lastPushed = serialized
  reasoningApi.sync(prefs)
}

function applyRemote(providerId: string, modelId: string, pref: ModelReasoningPref) {
  if (!providerId || !modelId || !pref || typeof pref.enabled !== "boolean") return
  // Marca como já enviado ANTES de aplicar: o push disparado pelo subscribe
  // veria exatamente este valor e o devolveria ao celular como se fosse novo.
  const prefs = useReasoningPrefsStore.getState().prefs
  lastPushed = JSON.stringify({ ...prefs, [`${providerId}/${modelId}`]: pref })
  useReasoningPrefsStore.getState().setPref(`${providerId}/${modelId}`, pref)
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  // Estado inicial: depois de um reload do renderer o cache do main precisa
  // ser repopulado, senão o mobile conecta e recebe um mapa vazio.
  push()
  useReasoningPrefsStore.subscribe(push)
  reasoningApi.onSelect(({ providerId, modelId, pref }) => {
    applyRemote(providerId, modelId, pref)
  })
}
