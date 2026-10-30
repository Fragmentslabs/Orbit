import { folderKey, normalizeFolderName, type FolderInfo, type SessionInfo } from "@shared/chat"

/**
 * Which workspace the new chat from a sidebar folder's "+" is born with.
 *
 * The order is the one the folder lives by:
 *
 * 1. The PREVIOUS CHAT — the most recent one of the folder, with the extra folders it
 *    had. It is the "continue from where I was": opening the folder's "+" after
 *    working in one of its chats lands in the same repository.
 * 2. The FOLDER MEMORY (`folders.workspace`) — written by the first chat that
 *    entered it and kept when the chats disappear. It is what answers with the folder
 *    EMPTY (all chats deleted), a case where before there was no answer at
 *    all and the workspace stayed as it was: the one of the last chat opened. Hence the
 *    "+" of the Nodara folder opening in the Orbit repository.
 * 3. The AUTOMATIC MAP directory → folder — the same one `createSession` uses
 *    to choose the folder of a project. It covers folders older than the field, which
 *    have not gone through the migration yet. The key is the main repository
 *    (worktree already resolved), which is exactly the right folder for a new chat.
 *
 * Returns `undefined` when there is no hint at all (folder created by hand and never
 * used): then the caller does not touch the workspace.
 */
export function workspaceOfFolder(input: {
  folder: FolderInfo
  /** All the store's sessions — including the archived ones, which the folder groups. */
  sessions: SessionInfo[]
  /** Automatic map directory → folder (localStorage, `orbit-auto-folder-map`). */
  autoFolderMap: Record<string, string>
}): string[] | undefined {
  const { folder, sessions, autoFolderMap } = input

  // 1) The most recent chat of the folder: it is the project it was being used with.
  //    Between ties, the first in the store order (most recent first).
  let mostRecent: SessionInfo | undefined
  for (const session of sessions) {
    if (session.folderId !== folder.id || !session.directory) continue
    if (!mostRecent || session.updatedAt > mostRecent.updatedAt) mostRecent = session
  }
  if (mostRecent) return sessionWorkspace(mostRecent)

  // 2) The folder memory (first chat that associated it with a repository).
  if (folder.workspace?.length) return folder.workspace

  // 3) The automatic map: directories that used to belong to this folder. The folder may
  //    have more than one (the same project opened by different paths, or a
  //    worktree from before the map started pointing to the main one), so the
  //    folder name breaks the tie.
  const fromMap = Object.entries(autoFolderMap)
    .filter(([, folderId]) => folderId === folder.id)
    .map(([directory]) => directory)
  if (fromMap.length > 0) {
    const byName = fromMap.find((dir) => folderKey(normalizeFolderName(dir)) === folderKey(folder.name))
    return [byName ?? fromMap[0]]
  }

  return undefined
}

/** The workspace the session had: main repository + extra folders. */
export function sessionWorkspace(session: SessionInfo): string[] | undefined {
  if (!session.directory) return undefined
  return [session.directory, ...(session.extraDirectories ?? [])]
}

/**
 * The OLDEST session of the folder that has a directory — the first one that associated it with
 * a repository. It is from that one that the folder takes the workspace memory when it
 * learns, and not from the most recent chat: the memory is the origin, not the use.
 */
export function firstSessionOfFolder(
  folderId: string,
  sessions: SessionInfo[],
): SessionInfo | undefined {
  let earliest: SessionInfo | undefined
  for (const session of sessions) {
    if (session.folderId !== folderId || session.mode !== "code" || !session.directory) continue
    if (!earliest || session.createdAt < earliest.createdAt) earliest = session
  }
  return earliest
}
