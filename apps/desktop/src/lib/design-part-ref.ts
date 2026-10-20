import type { ToolPart } from "@shared/chat"

/**
 * Referência de um canvas de design a partir da tool part (design_write /
 * design_edit / design_preview) — espelha motion-part-ref.ts. Os dois modos
 * endereçam o canvas de jeitos diferentes: o caminho da pasta do projeto
 * (design_preview, modo código) ou o nome do canvas da conversa (design_write
 * /design_edit, modo chat) — com fallback para o nome que a própria tool
 * relatou no texto (`Design "..."`), necessário quando o segmento vem de um
 * histórico antigo sem o input completo.
 */
export interface DesignPartRef {
  path?: string
  name?: string
  label: string
  boards?: number
}

/** Extrai o nome do canvas do relatório da tool (ver openDesignAndReport). */
export function designNameInReport(output: string | undefined): string | null {
  if (!output) return null
  const match = /Design "([^"]+)"/.exec(output)
  return match ? match[1] : null
}

/** Quantos artboards o relatório diz que o canvas tem. */
export function designBoardsInReport(output: string | undefined): number | null {
  if (!output) return null
  const match = /with (\d+) artboards?/.exec(output)
  return match ? Number(match[1]) : null
}

export function designRefOf(part: ToolPart): DesignPartRef | null {
  const input = part.input as Record<string, unknown> | undefined
  const path = typeof input?.path === "string" ? input.path : undefined
  const name = typeof input?.name === "string" ? input.name : undefined
  const label = path ? path.split(/[\\/]/).filter(Boolean).pop() : (name ?? designNameInReport(part.output) ?? undefined)
  if (!label) return null
  const boards = designBoardsInReport(part.output) ?? undefined
  return { path, name, label, boards }
}
