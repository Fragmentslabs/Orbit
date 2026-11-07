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
