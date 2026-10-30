import type { SessionInfo } from "@shared/chat"

/**
 * The folders of a chat, in the order the UI uses: the main one and then the extras.
 *
 * The session on disk is the only source that survives the app closing — the
 * workspace (localStorage) only keeps the last screen. That is why what the person
 * associates has to get here in the same click, and not on the next send.
 */
export function sessionFolders(
  session: Pick<SessionInfo, "directory" | "extraDirectories">,
): string[] {
  return [session.directory, ...(session.extraDirectories ?? [])].filter(
    (path): path is string => Boolean(path),
  )
}

/**
 * Is the screen's list already the session's?
 *
 * The main one weighs (it is the conversation's repository); the extras are a set,
 * so the order between them changes nothing and is not worth writing for.
 */
export function sameFolders(fromSession: string[], fromScreen: string[]): boolean {
  if (fromSession.length !== fromScreen.length) return false
  if (fromSession[0] !== fromScreen[0]) return false
  const extras = (list: string[]) => [...list.slice(1)].sort().join("\n")
  return extras(fromSession) === extras(fromScreen)
}
