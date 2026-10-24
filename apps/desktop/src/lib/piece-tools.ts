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
