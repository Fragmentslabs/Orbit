import type { SessionModeOverrides } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'
import { useModeOverrides, type OverridableMode } from '~/stores/mode-overrides'
import { useSimplePrefs } from '~/stores/simple-prefs'
import { useBrainPrefs } from '~/stores/brain-prefs'

/**
 * Modos ativos por chat vindos do desktop (pesquisa, navegador, plano,
 * subagentes, orquestração, visão, simples e brain). O desktop é a fonte da
 * verdade: empurra o mapa inteiro no connect (GET /api/session-modes) e a cada
 * mudança (evento WS 'session:mode-change').
 *
 * `authoritative` separa os dois casos: no snapshot do connect a escolha feita
 * no celular vence (só entram chaves que o mobile não tem), como já acontece
 * com o modelo por chat; no evento ao vivo o desktop acabou de mudar, então
 * ele sobrescreve.
 */

const MODE_OVERRIDE_KEYS: OverridableMode[] = [
  'search',
  'browser',
  'plan',
  'subagents',
  'orchestra',
  'vision',
]

/** O rascunho é por aparelho: "draft" no desktop é outro chat que "draft" no
 *  celular, então essa chave nunca viaja (nem daqui, nem de lá). */
const DRAFT_KEY = 'draft'

function sameMap(a: Record<string, boolean | undefined>, b: Record<string, boolean>): boolean {
  const aKeys = Object.keys(a).filter((k) => a[k] !== undefined)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length && bKeys.every((k) => a[k] === b[k])
}

/** Mescla um mapa sessionId → ativo; devolve null quando nada mudou.
 *
 *  No evento ao vivo o mapa do desktop substitui o local (só assim um modo
 *  desligado lá, que some do mapa, também some aqui); no snapshot do connect
 *  ele só preenche o que falta, para não desfazer escolha feita no celular. */
function merge(
  local: Record<string, boolean | undefined>,
  remote: Record<string, boolean> | undefined,
  authoritative: boolean,
): Record<string, boolean> | null {
  if (!remote || typeof remote !== 'object') return null

  if (authoritative) {
    const next: Record<string, boolean> = {}
    for (const [sessionId, value] of Object.entries(remote)) {
      if (sessionId === DRAFT_KEY || typeof value !== 'boolean') continue
      next[sessionId] = value
    }
    const draft = local[DRAFT_KEY]
    if (draft !== undefined) next[DRAFT_KEY] = draft
    return sameMap(local, next) ? null : next
  }

  const next = { ...local }
  let changed = false
  for (const [sessionId, value] of Object.entries(remote)) {
    if (sessionId === DRAFT_KEY || typeof value !== 'boolean') continue
    if (next[sessionId] !== undefined) continue
    next[sessionId] = value
    changed = true
  }
  return changed ? (next as Record<string, boolean>) : null
}

export function applyRemoteModes(remote: SessionModeOverrides, authoritative: boolean): void {
  if (!remote || typeof remote !== 'object') return

  const modeState = useModeOverrides.getState()
  const modeMap = { ...modeState.overrides }
  let modesChanged = false
  for (const mode of MODE_OVERRIDE_KEYS) {
    const merged = merge(modeMap[mode] ?? {}, remote[mode], authoritative)
    if (merged) {
      modeMap[mode] = merged
      modesChanged = true
    }
  }
  if (modesChanged) modeState.applySync(modeMap)

  const simpleState = useSimplePrefs.getState()
  const simple = merge(simpleState.overrides, remote.simple, authoritative)
  if (simple) simpleState.applySync(simple)

  const brainState = useBrainPrefs.getState()
  const brain = merge(brainState.overrides, remote.brain, authoritative)
  if (brain) brainState.applySync(brain)
}

/** O connect pode chegar antes da hidratação dos stores; aplicar o snapshot
 *  sobre um estado ainda vazio faria a hidratação seguinte desfazer tudo. */
async function ensureHydrated(): Promise<void> {
  const pending: Promise<void>[] = []
  if (!useModeOverrides.getState().hydrated) pending.push(useModeOverrides.getState().hydrate())
  if (!useSimplePrefs.getState().hydrated) pending.push(useSimplePrefs.getState().hydrate())
  if (!useBrainPrefs.getState().hydrated) pending.push(useBrainPrefs.getState().hydrate())
  if (pending.length > 0) await Promise.all(pending)
}

/** Snapshot dos modos por chat do desktop — chamado no connect. */
export async function fetchSessionModes(): Promise<void> {
  const { http } = useConnectionStore.getState()
  if (!http) return
  await ensureHydrated()
  try {
    const res = await http.getSessionModes()
    if (res.ok && res.data) {
      const remote = (res.data as { overrides?: SessionModeOverrides }).overrides
      if (remote) applyRemoteModes(remote, false)
    }
  } catch {
    // Offline — fica com o que já está no aparelho.
  }
}
