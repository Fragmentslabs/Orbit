import { folderKey, normalizeFolderName, type FolderInfo, type SessionMode } from "@shared/chat"

/**
 * Which folder receives a new code session, with "create folders
 * automatically" on.
 *
 * It lives outside the store because the decision is pure and the consequences are not: it
 * creates a folder, unarchives it, writes the map and persists the session. Separated, the
 * whole path can be closed off by a test — and it is a path that used to fail SILENTLY,
 * which is the worst way to fail: the session was born loose and nothing said why.
 *
 * The directory → folder map is a HINT, not a verdict. It keeps what
 * happened the last time, and what happened since then (the folder was
 * archived, renamed, deleted) it does not know.
 */
export interface AutoFolderPlan {
  /** Existing folder that receives the session. */
  folderId?: string
  /** Name of the folder to create, when none is usable. */
  create?: string
  /** The chosen folder is archived and needs to come back to the sidebar before
   *  receiving the session. */
  revive?: boolean
}

export function planAutoFolder(input: {
  directory: string
  mode: SessionMode
  folders: FolderInfo[]
  /** What the automatic map says about this directory, if it says anything. */
  mappedId?: string
}): AutoFolderPlan {
  const { directory, mode, folders, mappedId } = input

  // The folder pointed to by the map is only usable if it still exists and is of the same mode.
  // When it is not, the search by name takes over — before, this branch simply
  // did nothing, and since the map kept pointing to the same folder, the
  // project stayed without a folder FOR GOOD. Archiving a project's folder
  // turned its automatic creation off for good.
  const mapped = folders.find((f) => f.id === mappedId)
  if (mapped && mapped.mode === mode) {
    return { folderId: mapped.id, ...(mapped.archived ? { revive: true } : {}) }
  }

  // With no usable map, the project name decides. It covers the lost map
  // (cleared localStorage, new machine) and the same project opened by a different
  // path — trailing slash, another case, ~ instead of the absolute path.
  const name = normalizeFolderName(directory)
  const sameName = folders.filter((f) => f.mode === mode && folderKey(f.name) === folderKey(name))
  const alive = sameName.find((f) => !f.archived)
  if (alive) return { folderId: alive.id }
  // The archived one counts too: creating a second folder with the same name next to
  // it is exactly the duplicate that "Organize" exists to undo.
  if (sameName[0]) return { folderId: sameName[0].id, revive: true }

  return { create: name }
}
