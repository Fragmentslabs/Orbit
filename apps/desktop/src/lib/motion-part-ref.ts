import type { ToolPart } from "@shared/chat"

/**
 * Where the composition card reopens the piece from.
 *
 * The agent addresses the composition in TWO ways, and the card has to understand
 * both: in CODE mode it is a project folder and the tool receives `path`
 * (motion_preview); in CHAT mode it lives in Orbit's storage, one folder
 * per conversation, and the tool receives `name` (motion_write / motion_edit).
 *
 * The second case is what was missing: with no path at all in the `input` the card returned
 * null, and the composition created in the chat had no card in the conversation.
 */
export interface MotionPartRef {
  /** Composition addressed by the id (mv_…) — from any conversation. */
  id?: string
  /** Old composition, from the project folder: the path the agent passed to the tool. */
  path?: string
  /** Composition of the conversation: the name (already normalized) that the tool reports. */
  name?: string
  /** Card title: the piece name when there is one, otherwise the end of the path. */
  label: string
  /** Format measured by the tool ("1920×1080 · 38s"), when the report carries it. */
  format?: string
}

/** The piece name in the tool report: `Motion "<name>" …`. */
export function motionNameInReport(output: string | undefined): string | null {
  return output?.match(/Motion "([^"]+)"/)?.[1] ?? null
}

/**
 * The measured format, read from the same report (`… loads fine: 1920x1080, 1140
 * frames at 30 fps (38.00 s).`). It is what the card shows in the place where the
 * document one shows the type — measured by the tool, not guessed by the renderer.
 */
export function motionFormatInReport(output: string | undefined): string | null {
  const match = output?.match(/loads fine:\s*(\d+)x(\d+),\s*\d+\s*frames at\s*([\d.]+)\s*fps\s*\(([\d.]+)\s*s\)/)
  if (!match) return null
  return `${match[1]}×${match[2]} · ${Number(match[4])}s`
}

/** Last segment of the path, without depending on the node path in the renderer. */
function lastSegment(value: string): string {
  const segments = value.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? value
}

/**
 * The reference the card uses to reopen — or null when the tool left neither a path
 * nor a name to follow (then there is no card: a button that opens nothing
 * is worse than no card at all).
 */
export function motionRefOf(part: ToolPart): MotionPartRef | null {
  const input = part.input ?? {}
  const reported = motionNameInReport(part.output)
  const format = motionFormatInReport(part.output) ?? undefined
  // The id (mv_…) is the exact address — the piece may belong to another conversation.
  const id = typeof input.id === "string" && input.id.startsWith("mv_") ? input.id : undefined
  if (id) return { id, label: reported ?? id, format }
  // Path: the old pieces of code mode, which lived in the project folder.
  for (const key of ["path", "target", "file"]) {
    const value = input[key]
    if (typeof value === "string" && value) {
      return { path: value, label: reported ?? lastSegment(value), format }
    }
  }
  // Without a path, the piece belongs to the CONVERSATION — the name is what the tool reported (already
  // normalized into the slug that names the folder).
  if (reported) return { name: reported, label: reported, format }
  return null
}
