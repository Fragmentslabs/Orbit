import type { AppPreferences, MessageQueueSnapshot, SyncSnapshotResponse } from '@shared/companion'
import {
  getSessionModelsCache,
  getSessionModesCache,
  getSessionToolsCache,
  getSessionPrefsCache,
  getReasoningPrefsCache,
  getWorkerConfigCache,
} from './companion-http'

/**
 * The renderer's per-chat mirrors in one answer (`sync:get`). The phone reads each of them
 * from its own HTTP endpoint on connect; a desktop peer has none of those, and the
 * `*-change` broadcasts only carry what changes after it connected. The queue and the
 * app preferences live in companion-server, which hands them in.
 */
export function buildSyncSnapshot(own: { queues: MessageQueueSnapshot; appPrefs: AppPreferences | null }): SyncSnapshotResponse {
  return {
    models: getSessionModelsCache(),
    modes: getSessionModesCache(),
    tools: getSessionToolsCache(),
    prefs: getSessionPrefsCache(),
    reasoning: getReasoningPrefsCache(),
    workerConfig: getWorkerConfigCache(),
    appPrefs: own.appPrefs,
    queues: own.queues,
  }
}
