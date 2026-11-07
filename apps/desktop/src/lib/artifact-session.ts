import type { ArtifactRef } from "@shared/artifacts"
import type { SessionInfo } from "@shared/chat"

/**
 * The fields of a chat made INSIDE an artifact (from its card). The one place that knows how
 * each kind marks its specialist chat; the rest of the app asks for these fields and does not
 * branch on the kind.
 *
 * `ref` is absent while the artifact does not exist yet (the first chat of a new fragment).
 */
export function embeddedChatFields(
  kind: ArtifactRef["kind"],
  ref?: ArtifactRef,
  /** Fragment only: where it lives (screen / panel / widget), a hint for the agent. */
  fragmentKind: "screen" | "panel" | "widget" = "screen",
): Partial<SessionInfo> {
  const artifact = { kind, ...(ref ? { id: ref.id } : {}) }
  return kind === "fragment" ? { fragment: { kind: fragmentKind }, artifact } : { profile: kind, artifact }
}

/**
 * Whether a piece card shows the very artifact its own chat belongs to. Inside that chat the
 * artifact is already beside the conversation (and has its own card), so repeating it in the
 * transcript is noise. A chat whose artifact has no id yet is the first chat of a brand-new
 * one: every piece it makes is that artifact.
 */
export function isOwnArtifact(
  session: Pick<SessionInfo, "artifact"> | null | undefined,
  kind: ArtifactRef["kind"],
  id: string,
): boolean {
  const own = session?.artifact
  return Boolean(own && own.kind === kind && (!own.id || own.id === id))
}
