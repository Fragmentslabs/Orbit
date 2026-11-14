import type { QueuedMessage } from "@shared/chat"
import type { PeerSyncEvent } from "@shared/peers"
import type { SyncSnapshotResponse } from "@shared/companion"

/**
 * The other desktop's per-chat settings as plain data, and how a pushed `*:change` event
 * updates them. Keys are that machine's own chat ids. Kept apart from the store so the rules
 * are testable without the IPC bridge.
 */

export type RemoteSync = SyncSnapshotResponse

export const EMPTY_SYNC: RemoteSync = {
  models: {},
  modes: {},
  tools: {},
  prefs: { reasoning: {}, permission: {} },
  reasoning: {},
  workerConfig: { workerModel: null, workerReasoning: null, visionModel: null },
  appPrefs: null,
  queues: {},
}

export function applySyncEvent(sync: RemoteSync, event: PeerSyncEvent): RemoteSync {
  switch (event.type) {
    case "session:model-change":
      return { ...sync, models: event.overrides }
    case "session:mode-change":
      return { ...sync, modes: event.overrides }
    case "session:tools-change":
      return { ...sync, tools: event.overrides }
    case "session:prefs-change":
      return { ...sync, prefs: event.prefs }
    case "reasoning:change":
      return { ...sync, reasoning: event.prefs }
    case "worker-config:change":
      return { ...sync, workerConfig: event.config }
    case "prefs:change":
      return { ...sync, appPrefs: event.prefs }
    case "queue:change":
      return { ...sync, queues: event.queues }
    default:
      return sync
  }
}

const NO_ITEMS: QueuedMessage[] = []
export const queueOf = (sync: RemoteSync | undefined, sessionId: string | undefined): QueuedMessage[] =>
  (sessionId && sync?.queues[sessionId]) || NO_ITEMS

