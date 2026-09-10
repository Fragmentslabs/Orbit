import type { MessagePart, ModelRotation, RotationConfig, RotationModel } from '@shared/chat'
import { getSessionModelsCache } from './companion-http'

/**
 * Rotação de modelos — listas nomeadas de modelos (1..4 slots) escolhidas
 * POR CHAT no seletor, como um modelo.
 *
 * Resolução da sequência:
 * 1. rotação escolhida para o chat (override no seletor) → a lista ordenada
 *    da rotação (até MAX_ROTATION_ATTEMPTS tentativas);
 * 2. senão, modelo pinado no chat (escolha explícita no seletor) → sequência
 *    de 1 — o usuário que pinar um modelo continua pinado;
 * 3. senão, o default global (o modelo que o renderer resolveu no envio).
 *
 * O override por chat (modelo) chega aqui via `getSessionModelsCache()` — o
 * renderer empurra o mapa inteiro no `companion:session-models` a cada
 * mudança (e no load, repopulando o cache após reload). A escolha de rotação
 * por chat chega no mesmo `rotation:sync` que carrega a lista.
 */

export const MAX_ROTATION_ATTEMPTS = 3
export const MAX_ROTATION_SLOTS = 4
const DRAFT_KEY = 'draft'

let rotationConfigCache: RotationConfig = { rotations: [], sessionOverrides: {} }

/** Renderer → main (`rotation:sync`): o main guarda o estado em cache e o
 *  engine resolve a sequência no momento da chamada. */
export function setRotationConfigCache(config: RotationConfig | null | undefined): void {
  rotationConfigCache = config ?? { rotations: [], sessionOverrides: {} }
}

export function getRotationConfigCache(): RotationConfig {
  return rotationConfigCache
}

/** Sequência de modelos do turno, segundo a regra acima. `fallbackModel`
 *  é o modelo que o renderer resolveu (override ou default global) — usado
 *  como sequência de 1 quando não há rotação escolhida para o chat. */
export function resolveRotation(
  sessionId: string | undefined,
  fallbackModel: RotationModel,
): RotationModel[] {
  const sessionKey = sessionId ?? DRAFT_KEY

  // 1. rotação escolhida no seletor para este chat
  const pinnedRotationId = rotationConfigCache.sessionOverrides[sessionKey]
  if (pinnedRotationId) {
    const rotation = rotationConfigCache.rotations.find((r: ModelRotation) => r.id === pinnedRotationId)
    if (rotation && rotation.models.length > 0) {
      return rotation.models.slice(0, MAX_ROTATION_ATTEMPTS)
    }
  }

  // 2. override por chat pina (draft = chat novo antes do primeiro envio)
  const overrides = getSessionModelsCache()
  const pinned = overrides[sessionKey]
  if (pinned) return [pinned]

  // 3. comportamento atual
  return [fallbackModel]
}

/** Próximo modelo da sequência (undefined = esgotou). */
export function selectNext(seq: RotationModel[], index: number): RotationModel | undefined {
  return seq[index]
}

/** true quando o turno já emitiu conteúdo (texto/raciocínio/tool) — a v1 só
 *  rotaciona falhas ANTES do primeiro token de saída; reenviar conteúdo já
 *  entregue custaria tokens duplicados. */
export function hasStreamedContent(parts: MessagePart[]): boolean {
  return parts.some(
    (p) => p.type === 'tool' || ((p.type === 'text' || p.type === 'reasoning') && (p.text?.length ?? 0) > 0),
  )
}