const BUSY = new Set(["submitted", "streaming"])

export interface ArtifactActivity {
  /** A chat is working on the artifact right now. */
  working: boolean
  /** Something new happened in one of its chats that the person has not seen. */
  unread: boolean
}

/** Pure: what a list of chats says about the artifact, given their statuses and unread counts. */
export function summarizeActivity(
  chats: readonly string[],
  status: Record<string, string | undefined>,
  unreadCounts: Record<string, number | undefined>,
): ArtifactActivity {
  const working = chats.some((id) => BUSY.has(status[id] ?? ""))
  const unread = chats.some((id) => (unreadCounts[id] ?? 0) > 0)
  // A chat still working has not finished: the spinner wins over the bullet.
  return { working, unread: !working && unread }
}

