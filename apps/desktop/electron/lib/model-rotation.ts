import type { MessagePart, ModelRotation, RotationConfig, RotationModel } from '@shared/chat'
import { getSessionModelsCache } from './companion-http'

/**
 * Model rotation — named lists of models (1..4 slots) chosen
 * PER CHAT in the selector, like a model.
 *
 * Resolution of the sequence:
 * 1. rotation chosen for the chat (override in the selector) → the rotation's ordered
 *    list (up to MAX_ROTATION_ATTEMPTS attempts);
 * 2. otherwise, model pinned in the chat (explicit choice in the selector) → sequence
 *    of 1 — whoever pins a model stays pinned;
 * 3. otherwise, the global default (the model the renderer resolved on send).
 *
 * The per-chat override (model) arrives here via `getSessionModelsCache()` — the
 * renderer pushes the whole map in `companion:session-models` on every
 * change (and on load, repopulating the cache after a reload). The rotation choice
 * per chat arrives in the same `rotation:sync` that carries the list.
 */

export const MAX_ROTATION_ATTEMPTS = 3
export const MAX_ROTATION_SLOTS = 4
const DRAFT_KEY = 'draft'

let rotationConfigCache: RotationConfig = { rotations: [], sessionOverrides: {} }

/** Renderer → main (`rotation:sync`): the main caches the state and the
 *  engine resolves the sequence at call time. */
export function setRotationConfigCache(config: RotationConfig | null | undefined): void {
  rotationConfigCache = config ?? { rotations: [], sessionOverrides: {} }
}

export function getRotationConfigCache(): RotationConfig {
  return rotationConfigCache
}

/** Sequence of models for the turn, according to the rule above. `fallbackModel`
 *  is the model the renderer resolved (override or global default) — used
 *  as a sequence of 1 when there is no rotation chosen for the chat. */
export function resolveRotation(
  sessionId: string | undefined,
  fallbackModel: RotationModel,
): RotationModel[] {
  const sessionKey = sessionId ?? DRAFT_KEY

  // 1. rotation chosen in the selector for this chat
  const pinnedRotationId = rotationConfigCache.sessionOverrides[sessionKey]
  if (pinnedRotationId) {
    const rotation = rotationConfigCache.rotations.find((r: ModelRotation) => r.id === pinnedRotationId)
    if (rotation && rotation.models.length > 0) {
      return rotation.models.slice(0, MAX_ROTATION_ATTEMPTS)
    }
  }

  // 2. per-chat override pins (draft = new chat before the first send)
  const overrides = getSessionModelsCache()
  const pinned = overrides[sessionKey]
  if (pinned) return [pinned]

  // 3. current behavior
  return [fallbackModel]
}

/** Next model of the sequence (undefined = exhausted). */
export function selectNext(seq: RotationModel[], index: number): RotationModel | undefined {
  return seq[index]
}

/** true when the turn has already emitted content (text/reasoning/tool) — v1 only
 *  rotates failures BEFORE the first output token; resending content already
 *  delivered would cost duplicate tokens. */
export function hasStreamedContent(parts: MessagePart[]): boolean {
  return parts.some(
    (p) => p.type === 'tool' || ((p.type === 'text' || p.type === 'reasoning') && (p.text?.length ?? 0) > 0),
  )
}
/** Wait before each extra round of the turn (SendMessageOptions.retries).
 *  Increasing because the typical case is the network down: trying again in seconds
 *  only spends the rounds before it comes back. Past the end, it repeats the last one. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000]

export function retryDelay(round: number): number {
  return RETRY_DELAYS_MS[Math.min(round, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0]
}

/** Waits `ms`, but comes back right away if the turn is interrupted — the stop
 *  button cannot stay stuck behind a 30s wait. */
export function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}
