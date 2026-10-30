import type { ToolPart } from "@shared/chat"

/**
 * Reference of a slide deck from the tool part (slides_preview /
 * slides_write) — mirrors design-part-ref.ts.
 *
 * The two modes address the deck in different ways: the project folder path
 * (slides_preview, code mode) or the deck title in the conversation
 * (slides_write, chat mode) — with a fallback to the name the tool itself
 * reported in the text (`Deck "..."`), needed when the segment comes from an old
 * history without the complete input.
 */
export interface SlidesPartRef {
  /** Deck addressed by the id (sld_…) — from any conversation. */
  id?: string
  path?: string
  name?: string
  label: string
  slides?: number
}

/** Extracts the deck name from the tool report (see openSlidesAndReport). */
export function slidesNameInReport(output: string | undefined): string | null {
  if (!output) return null
  const match = /Deck "([^"]+)"/.exec(output)
  return match ? match[1] : null
}

/** How many slides the report says the deck has. */
export function slidesCountInReport(output: string | undefined): number | null {
  if (!output) return null
  const match = /with (\d+) slides?/.exec(output)
  return match ? Number(match[1]) : null
}

export function slidesRefOf(part: ToolPart): SlidesPartRef | null {
  const input = part.input as Record<string, unknown> | undefined
  const rawPath = typeof input?.path === "string" ? input.path : undefined
  // slides_write addresses by `title`; slides_edit and slides_preview, by `name`.
  const title = typeof input?.title === "string" ? input.title : typeof input?.name === "string" ? input.name : undefined
  const id = typeof input?.id === "string" && input.id.startsWith("sld_") ? input.id : undefined
  // `slides_write` addresses by TITLE and main resolves the folder by the slug of the
  // title (slides-slug.ts) — nothing is normalized here, so as not to duplicate the
  // rule in two places.
  const name = title?.trim() || undefined
  const label = rawPath
    ? rawPath.split(/[\\/]/).filter(Boolean).pop()
    : (title ?? slidesNameInReport(part.output) ?? id ?? undefined)
  if (!label) return null
  const slides = slidesCountInReport(part.output) ?? undefined
  return { id, path: rawPath, name, label, slides }
}
