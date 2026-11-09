import type { SessionInfo, SessionMode } from "@shared/chat"

/**
 * The chat a new one copies its model and modes from: the most recently touched conversation of
 * the same mode that is still open. Workers, archived chats and routine runs do not count — a
 * routine's run is the scheduler's chat, not one the person was using. Falls back to any other mode
 * so a first chat in one mode still starts from what the person last used.
 */
export function lastUsedChat(sessions: readonly SessionInfo[], mode: SessionMode, excludeId?: string): SessionInfo | undefined {
  const usable = sessions.filter((s) => !s.archived && !s.parentId && !s.routineId && s.id !== excludeId)
  const newest = (list: SessionInfo[]) => [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return newest(usable.filter((s) => s.mode === mode)) ?? newest(usable)
}
