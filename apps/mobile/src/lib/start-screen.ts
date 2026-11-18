import type { SessionInfo, SessionMode } from '@orbit/shared'

/** YYYY-MM-DD in local time: the seed that keeps the day's suggestions the same all day long. */
export function dayKey(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * The conversation "Resume" offers: the most recent top-level one of the same mode. The desktop's
 * rule, line for line:
 * - archived chats and sub-agent chats never count;
 * - in code only a session of the open folder (another repository would be another context);
 * - the open session is skipped, so a new empty chat still gets the invitation to go back to the one before.
 */
export function lastSessionForStart(
  sessions: readonly SessionInfo[],
  options: { mode: SessionMode; directory?: string; currentId?: string },
): { id: string; title: string; mode: SessionMode } | undefined {
  let recent: SessionInfo | undefined
  for (const item of sessions) {
    if (item.archived || item.parentId || item.mode !== options.mode) continue
    if (options.mode === 'code' && item.directory !== options.directory) continue
    if (item.id === options.currentId) continue
    if (!recent || item.updatedAt > recent.updatedAt) recent = item
  }
  return recent ? { id: recent.id, title: recent.title, mode: recent.mode } : undefined
}
