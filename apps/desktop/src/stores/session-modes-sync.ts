import type { ChatModeKey, SessionModeOverrides } from "@shared/companion"
import { sessionModesApi } from "@/src/lib/ipc"
import { useModeOverrides, type OverridableMode } from "@/src/stores/mode-overrides"
import { useSimplePrefs } from "@/src/stores/simple-prefs"
import { useBrainPrefs } from "@/src/stores/brain-prefs"

/**
 * Sincronização dos modos ativos POR CHAT com os companions (mobile), no mesmo
 * desenho do session-model-prefs: o renderer é a fonte da verdade (os modos
 * vivem no localStorage dele), empurra o mapa inteiro para o main a cada
 * mudança e aplica os toggles que chegam do celular.
 *
 * Os seis modos do mode-overrides viajam junto de 'simple' e 'brain', que têm
 * store próprio — o mapa é achatado em modo → (sessionId → ativo).
 */

/** O rascunho é por aparelho: "draft" aqui é um chat novo diferente do "draft"
 *  do celular, então essa chave fica fora do que vai para os companions. */
const DRAFT_KEY = "draft"

function withoutDraft(bySession: Record<string, boolean>): Record<string, boolean> {
  const { [DRAFT_KEY]: _draft, ...rest } = bySession
  return rest
}

const MODE_OVERRIDE_KEYS: OverridableMode[] = [
  "search",
  "browser",
  "plan",
  "subagents",
  "orchestra",
  "vision",
]

function snapshot(): SessionModeOverrides {
  const map: SessionModeOverrides = {}
  const overrides = useModeOverrides.getState().overrides
  for (const mode of MODE_OVERRIDE_KEYS) {
    const bySession = overrides[mode]
    if (!bySession) continue
    const shared = withoutDraft(bySession)
    if (Object.keys(shared).length > 0) map[mode] = shared
  }
  // simple guarda só as ativações; brain, só as desativações — os defaults
  // opostos de cada um ficam implícitos na ausência da chave, dos dois lados.
  const simple = useSimplePrefs.getState().overrides
  const simpleEntries = Object.entries(simple).filter(
    ([key, value]) => key !== DRAFT_KEY && value !== undefined,
  )
  if (simpleEntries.length > 0) {
    map.simple = Object.fromEntries(simpleEntries as [string, boolean][])
  }
  const brain = withoutDraft(useBrainPrefs.getState().overrides)
  if (Object.keys(brain).length > 0) map.brain = brain
  return map
}

function push() {
  sessionModesApi.sync(snapshot())
}

/** Aplica um toggle vindo de um companion no store certo. */
function applyRemote(mode: ChatModeKey, sessionId: string | null, value: boolean) {
  if (mode === "simple") {
    useSimplePrefs.getState().setEnabled(sessionId, value)
    return
  }
  if (mode === "brain") {
    useBrainPrefs.getState().setEnabled(sessionId, value)
    return
  }
  useModeOverrides.getState().setMode(mode, sessionId, value)
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  // Estado inicial: depois de um reload do renderer o cache do main precisa
  // ser repopulado, senão o mobile conecta e recebe um mapa vazio.
  push()
  useModeOverrides.subscribe(push)
  useSimplePrefs.subscribe(push)
  useBrainPrefs.subscribe(push)
  sessionModesApi.onSelect(({ mode, value, sessionId }) => {
    applyRemote(mode, sessionId ?? null, value)
  })
}
