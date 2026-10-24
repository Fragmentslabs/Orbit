import type { ToolPart } from "@shared/chat"

/**
 * Referência de um deck de slides a partir da tool part (slides_preview /
 * slides_write) — espelha design-part-ref.ts.
 *
 * Os dois modos endereçam o deck de jeitos diferentes: o caminho da pasta do
 * projeto (slides_preview, modo código) ou o título do deck na conversa
 * (slides_write, modo chat) — com fallback para o nome que a própria tool
 * relatou no texto (`Deck "..."`), necessário quando o segmento vem de um
 * histórico antigo sem o input completo.
 */
export interface SlidesPartRef {
  path?: string
  name?: string
  label: string
  slides?: number
}

/** Extrai o nome do deck do relatório da tool (ver openSlidesAndReport). */
export function slidesNameInReport(output: string | undefined): string | null {
  if (!output) return null
  const match = /Deck "([^"]+)"/.exec(output)
  return match ? match[1] : null
}

/** Quantos slides o relatório diz que o deck tem. */
export function slidesCountInReport(output: string | undefined): number | null {
  if (!output) return null
  const match = /with (\d+) slides?/.exec(output)
  return match ? Number(match[1]) : null
}

export function slidesRefOf(part: ToolPart): SlidesPartRef | null {
  const input = part.input as Record<string, unknown> | undefined
  const rawPath = typeof input?.path === "string" ? input.path : undefined
  const title = typeof input?.title === "string" ? input.title : undefined
  // `slides_write` endereça pelo TÍTULO e o main resolve a pasta pelo slug do
  // título (slides-slug.ts) — aqui não se normaliza nada, para não duplicar a
  // regra em dois lugares.
  const name = title?.trim() || undefined
  const label = rawPath
    ? rawPath.split(/[\\/]/).filter(Boolean).pop()
    : (title ?? slidesNameInReport(part.output) ?? undefined)
  if (!label) return null
  const slides = slidesCountInReport(part.output) ?? undefined
  return { path: rawPath, name, label, slides }
}
