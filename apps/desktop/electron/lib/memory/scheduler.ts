import { runMemoryRoutine } from './routine'
import { cleanup, scheduleIndexSync } from './service'

/**
 * Memory maintenance cron: expiry + automatic promotion + embedding index
 * + routine (daily capture / weekly consolidation).
 * Runs every 6 hours while the app is open.
 *
 * Indexing lives here (and not on the path of the first question) on purpose:
 * reindexing 300 memories takes a few seconds and must not delay the conversation.
 * `scheduleIndexSync` is debounced and runs in the background; if the model is not
 * installed, the sync fails silently and the app keeps going on the lexical path.
 */

const INTERVAL = 6 * 60 * 60 * 1000
/**
 * The first pass waits for the settings. The scheduler starts with the
 * window, before `loadAppSettings` — running the routine at that point would read the
 * default ("off") and the first capture would only happen 6 hours later.
 */
const FIRST_RUN_DELAY = 60 * 1000

export function setupMemoryScheduler(): void {
  const run = () => {
    void cleanup().catch((err) => console.error('[memory] cleanup failed:', err))
    // Each phase of the routine limits itself by the preference and by the window: the
    // 6h tick only provides the ride.
    void runMemoryRoutine().catch((err) => console.error('[memory] routine failed:', err))
    scheduleIndexSync(500)
  }
  setTimeout(run, FIRST_RUN_DELAY).unref?.()
  setInterval(run, INTERVAL).unref?.()
}
