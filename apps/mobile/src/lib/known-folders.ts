import { folderName } from '~/lib/folder-name'

/**
 * The project folders the phone can offer without browsing the desktop disk: the ones its
 * chats already work in, the working folders of its pipeline projects and the ones recently
 * picked on this phone. Pure — the screens feed it and render the result.
 */

export interface KnownFolder {
  path: string
  /** The name the phone shows: its own alias when set, otherwise the last path segment. */
  name: string
  chatCount: number
  /** Most recent activity in that folder (0 when it only comes from recents/projects). */
  lastUsedAt: number
}

interface SessionLike {
  directory?: string
  updatedAt?: number
  routineId?: string
  fragment?: unknown
}

export interface KnownFoldersInput {
  sessions: readonly SessionLike[]
  projectFolders?: readonly string[]
  recents?: readonly string[]
  /** Folders the person removed from the phone's list (the desktop is untouched). */
  hidden?: readonly string[]
  aliases?: Readonly<Record<string, string>>
}

/** `/a/b/` and `/a/b` are the same folder. The root and Windows drive roots keep their slash. */
export function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.length <= 1 || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed
  return trimmed.replace(/[\\/]+$/, '')
}

export function collectKnownFolders(input: KnownFoldersInput): KnownFolder[] {
  const hidden = new Set((input.hidden ?? []).map(normalizePath))
  const byPath = new Map<string, KnownFolder>()
  const touch = (raw: string | undefined) => {
    if (!raw) return null
    const path = normalizePath(raw)
    if (!path || hidden.has(path)) return null
    let entry = byPath.get(path)
    if (!entry) {
      entry = { path, name: input.aliases?.[path]?.trim() || folderName(path), chatCount: 0, lastUsedAt: 0 }
      byPath.set(path, entry)
    }
    return entry
  }

  for (const s of input.sessions) {
    // Routine runs and fragment builders work in a folder too, but they are not "chats in it".
    if (s.routineId || s.fragment) continue
    const entry = touch(s.directory)
    if (!entry) continue
    entry.chatCount += 1
    entry.lastUsedAt = Math.max(entry.lastUsedAt, s.updatedAt ?? 0)
  }
  for (const p of input.projectFolders ?? []) touch(p)
  // Recents are ordered most-recent-first; keep that order as the tie-breaker below.
  const recentRank = new Map<string, number>()
  ;(input.recents ?? []).forEach((p, i) => {
    const entry = touch(p)
    if (entry) recentRank.set(entry.path, i)
  })

  return [...byPath.values()].sort((a, b) => {
    if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt
    const ra = recentRank.get(a.path) ?? Number.MAX_SAFE_INTEGER
    const rb = recentRank.get(b.path) ?? Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    return a.name.localeCompare(b.name)
  })
}

/** Chats that belong to a folder (main directory), newest first. */
export function chatsInFolder<T extends SessionLike & { id: string }>(sessions: readonly T[], path: string): T[] {
  const target = normalizePath(path)
  return sessions
    .filter((s) => !s.routineId && !s.fragment && s.directory && normalizePath(s.directory) === target)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}
