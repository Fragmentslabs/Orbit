import type { ToolPart } from "@shared/chat"

/**
 * Reference of a design canvas from the tool part (design_write /
 * design_edit / design_preview) — mirrors motion-part-ref.ts. The two modes
 * address the canvas in different ways: the project folder path
 * (design_preview, code mode) or the conversation's canvas name (design_write
 * /design_edit, chat mode) — with a fallback to the name the tool itself
 * reported in the text (`Design "..."`), needed when the segment comes from an old
 * history without the complete input.
 */
export interface DesignPartRef {
  /** Canvas addressed by the id (dsg_…) — from any conversation. */
  id?: string
  path?: string
  name?: string
  label: string
  boards?: number
}

/** Extracts the canvas name from the tool report (see openDesignAndReport). */
export function designNameInReport(output: string | undefined): string | null {
  if (!output) return null
  const match = /Design "([^"]+)"/.exec(output)
  return match ? match[1] : null
}

/** How many artboards the report says the canvas has. */
export function designBoardsInReport(output: string | undefined): number | null {
  if (!output) return null
  const match = /with (\d+) artboards?/.exec(output)
  return match ? Number(match[1]) : null
}

export function designRefOf(part: ToolPart): DesignPartRef | null {
  const input = part.input as Record<string, unknown> | undefined
  const path = typeof input?.path === "string" ? input.path : undefined
  const name = typeof input?.name === "string" ? input.name : undefined
  const id = typeof input?.id === "string" && input.id.startsWith("dsg_") ? input.id : undefined
  const label = path ? path.split(/[\\/]/).filter(Boolean).pop() : (name ?? designNameInReport(part.output) ?? id ?? undefined)
  if (!label) return null
  const boards = designBoardsInReport(part.output) ?? undefined
  return { id, path, name, label, boards }
}
