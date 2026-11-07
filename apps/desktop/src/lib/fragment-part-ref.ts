import type { ToolPart } from "@shared/chat"

/** The fragment a tool call touched — the card's address. */
export interface FragmentPartRef {
  id: string
  /** Name the tool call carried (only a creation has one); otherwise the card reads it from the store. */
  name?: string
}

/**
 * Where a fragment card reopens from. `fragment_create` returns the id in its result, the
 * other tools take it as an argument. No id (a call that failed before it existed) means no
 * card: a button that opens nothing is worse than none.
 */
export function fragmentRefOf(part: ToolPart): FragmentPartRef | null {
  const input = part.input ?? {}
  const fromInput = typeof input.fragmentId === "string" ? input.fragmentId : undefined
  let fromOutput: string | undefined
  if (!fromInput && part.output) {
    try {
      const parsed: unknown = JSON.parse(part.output)
      const id = (parsed as { fragmentId?: unknown } | null)?.fragmentId
      if (typeof id === "string") fromOutput = id
    } catch {
      /* a plain-text result carries no id */
    }
  }
  const id = fromInput ?? fromOutput
  if (!id) return null
  return { id, name: typeof input.name === "string" ? input.name : undefined }
}
