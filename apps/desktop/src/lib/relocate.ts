import { normalizeFolderName, type SessionInfo } from "@shared/chat"

/**
 * Revalidation of the working folders.
 *
 * A folder path is stored as a STRING — in the session directory, in the
 * directory → folder map and in the workspace folder list. Renaming, moving or
 * deleting the folder in Finder warns nobody: the three references keep
 * pointing into the void, and Orbit only finds out on the day it tries to use them.
 *
 * Here lives the part that decides WHAT disappeared and WHAT to do with each reference
 * when the person relocates the folder. Pure on purpose: it is closed off by tests,
 * without Electron and without a store.
 */

/** A referenced folder that no longer exists on disk. */
export interface MissingFolder {
  /** The path exactly as it is stored — it is the key of the reconnection. */
  path: string
  /** Short name for the UI (the last segment of the path). */
  name: string
}

/** Last segment of the path ("/a/b/my-app" → "my-app"). */
export function folderBaseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** The folder paths of a session, the main one first. */
export function sessionFolderPaths(
  session: Pick<SessionInfo, "directory" | "extraDirectories">,
): string[] {
  return [session.directory, ...(session.extraDirectories ?? [])].filter(
    (path): path is string => Boolean(path),
  )
}

/**
 * All the referenced paths — from the workspace folders and from the sessions —
 * without repetition and in the order they appear.
 */
export function collectFolderPaths(
  workspaceFolders: string[],
  sessions: ReadonlyArray<Pick<SessionInfo, "directory" | "extraDirectories">>,
): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const path of [...workspaceFolders, ...sessions.flatMap(sessionFolderPaths)]) {
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/**
 * The paths that no longer exist, in the order of `paths`.
 *
 * Only `false` counts: a path that was not even checked (main did not answer, the
 * list changed midway) is a doubt, and a doubt does not become an alert — otherwise the notice
 * is born lying.
 */
export function missingFolders(paths: string[], existing: Record<string, boolean>): MissingFolder[] {
  return paths
    .filter((path) => existing[path] === false)
    .map((path) => ({ path, name: folderBaseName(path) }))
}

/**
 * Reconnects a session from `oldPath` to `newPath`: the main directory and the
 * extra folders, in the position they were in. `null` when the session does not
 * reference the path — it is what keeps the operation surgical, without touching
 * whoever has nothing to do with it.
 */
export function relocateSessionFolders(
  session: Pick<SessionInfo, "directory" | "extraDirectories">,
  oldPath: string,
  newPath: string,
): Partial<Pick<SessionInfo, "directory" | "extraDirectories">> | null {
  const extras = session.extraDirectories ?? []
  const hitMain = session.directory === oldPath
  const hitExtra = extras.includes(oldPath)
  if (!hitMain && !hitExtra) return null
  return {
    ...(hitMain ? { directory: newPath } : {}),
    ...(hitExtra
      ? { extraDirectories: extras.map((path) => (path === oldPath ? newPath : path)) }
      : {}),
  }
}

/**
 * Moves the automatic map entry to the new path. If the destination already has a
 * folder (the person already worked from there), the old entry leaves without overwriting:
 * switching the owner of the new path would be worse than losing the old hint.
 */
export function relocateAutoFolderEntry(
  map: Record<string, string>,
  oldPath: string,
  newPath: string,
): Record<string, string> | null {
  const folderId = map[oldPath]
  if (!folderId) return null
  const next = { ...map }
  delete next[oldPath]
  if (!(newPath in next)) next[newPath] = folderId
  return next
}

/**
 * The folder's workspace memory (`FolderInfo.workspace`) follows the relocated
 * project, in the position where the path was. `null` when it does not
 * reference the path — same as `relocateSessionFolders`, so the operation
 * touches only whoever has to do with it.
 */
export function relocateFolderWorkspace(
  workspace: string[] | undefined,
  oldPath: string,
  newPath: string,
): string[] | null {
  if (!workspace?.includes(oldPath)) return null
  return workspace.map((path) => (path === oldPath ? newPath : path))
}

/**
 * The folder name in the sidebar follows the project: if it is still the one derived from the
 * old path ("my-app" → "My App"), leaving it as it is makes the folder lie
 * about what is inside after being relocated. A name edited by hand is the person's
 * decision and is not touched — that is why there is a comparison, and not a direct assignment.
 */
export function relocatedFolderName(
  currentName: string,
  oldPath: string,
  newPath: string,
): string | null {
  if (currentName !== normalizeFolderName(oldPath)) return null
  const next = normalizeFolderName(newPath)
  return next === currentName ? null : next
}
