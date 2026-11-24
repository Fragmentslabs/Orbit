import { cancelAllFor } from './fragment-notify'
import { fragmentEvents, removeFragment } from './fragment-store'

/**
 * Deletes a fragment and everything that hung from it: its notifications, and the announcement every view
 * waits for (the desktop's tabs and the phones). The desktop's Delete and the phone's long press come
 * through here, so both leave the same trail. Returns whether it existed.
 */
export async function deleteFragment(id: string): Promise<boolean> {
  const removed = await removeFragment(id)
  if (!removed) return false
  await cancelAllFor(id)
  fragmentEvents.emit('removed', { fragmentId: id })
  return true
}
