import type { MessagePart, ToolPart } from "@shared/chat"
import { designRefOf } from "./design-part-ref"
import { motionRefOf } from "./motion-part-ref"
import { slidesRefOf } from "./slides-part-ref"

/**
 * As tools de peça (motion, design, slides) que deixam CARD na conversa — o
 * mesmo conjunto no chat e no código, porque as tools são as mesmas nos dois
 * modos. Fechar a aba do painel não pode tirar a peça de vista: o card é a
 * porta de volta. Ler, copiar asset, olhar quadros e excluir não deixam card.
 */
export const MOTION_CARD_TOOLS = new Set(["motion_write", "motion_edit", "motion_preview"])
export const DESIGN_CARD_TOOLS = new Set(["design_write", "design_edit", "design_preview"])
export const SLIDES_CARD_TOOLS = new Set(["slides_write", "slides_edit", "slides_preview"])

export function isPieceCardTool(tool: string): boolean {
  return MOTION_CARD_TOOLS.has(tool) || DESIGN_CARD_TOOLS.has(tool) || SLIDES_CARD_TOOLS.has(tool)
}

/**
 * Identidade da peça por trás de um card, para a mensagem mostrar UM card por
 * peça: o design é escrito uma tela por chamada, e seis `design_write` na mesma
 * resposta davam seis cards do mesmo canvas, enchendo a conversa com o mesmo
 * botão. O que as chamadas têm em comum é a PEÇA — o id (dsg_…) quando o
 * histórico o traz, senão o caminho ou o nome que a tool endereçou.
 */
export function pieceCardKeyOf(part: MessagePart): string | null {
  if (part.type !== "tool" || !isPieceCardTool(part.tool)) return null
  const tool: ToolPart = part
  if (MOTION_CARD_TOOLS.has(tool.tool)) {
    const ref = motionRefOf(tool)
    const key = ref?.id ?? ref?.path ?? ref?.name
    return key ? `motion:${key}` : null
  }
  if (DESIGN_CARD_TOOLS.has(tool.tool)) {
    const ref = designRefOf(tool)
    const key = ref?.id ?? ref?.path ?? ref?.name
    return key ? `design:${key}` : null
  }
  const ref = slidesRefOf(tool)
  const key = ref?.id ?? ref?.path ?? ref?.name
  return key ? `slides:${key}` : null
}

/**
 * Guarda o card de uma peça na mensagem — UM por peça. `design_write` roda uma
 * tela por chamada, e cada uma empilhava outro card do mesmo canvas: a conversa
 * ficava com quatro botões para o mesmo lugar. O card do PRIMEIRO lugar fica, e
 * passa a mostrar a chamada NOVA, que é a que sabe o estado final da peça
 * ("4 telas" em vez de "1 tela"); as seguintes não acrescentam nada.
 *
 * Devolve o segmento quando ele é novo — quem chama decide onde ele entra —, e
 * `null` quando a peça já tinha card ali.
 */
export function landPieceCard<S extends { part: MessagePart }>(
  cards: Map<string, S>,
  part: MessagePart,
  create: (part: MessagePart) => S,
): S | null {
  const key = pieceCardKeyOf(part)
  if (!key) return create(part)
  const existing = cards.get(key)
  if (existing) {
    existing.part = part
    return null
  }
  const segment = create(part)
  cards.set(key, segment)
  return segment
}
