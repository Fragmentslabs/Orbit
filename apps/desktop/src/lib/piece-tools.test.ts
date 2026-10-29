import { describe, expect, it } from "vitest"
import type { MessagePart, ToolPart } from "@shared/chat"
import { landPieceCard, pieceCardKeyOf } from "./piece-tools"

/** O relatório que a tool devolve ao registrar o canvas (resumido). */
function designWrite(id: string, name: string, boards: number): ToolPart {
  return {
    id,
    type: "tool",
    tool: "design_write",
    state: "done",
    input: { name },
    output: `Design "${name}" is open in the Design tab of the right panel and has ${boards} artboards.`,
  }
}

function motionWrite(id: string, name: string): ToolPart {
  return { id, type: "tool", tool: "motion_write", state: "done", input: { name }, output: `Motion "${name}" is open.` }
}

function slidesWrite(id: string, title: string, slides: number): ToolPart {
  return {
    id,
    type: "tool",
    tool: "slides_write",
    state: "done",
    input: { title },
    output: `Deck "${title}" is open with ${slides} slides.`,
  }
}

/** Um segmento de card como o construtor de segmentos da conversa o monta. */
type Card = { kind: "part"; id: string; part: MessagePart }
const create = (part: MessagePart): Card => ({ kind: "part", id: part.id, part })

function build(parts: MessagePart[]): Card[] {
  const cards = new Map<string, Card>()
  const segments: Card[] = []
  for (const part of parts) {
    const segment = landPieceCard(cards, part, create)
    if (segment) segments.push(segment)
  }
  return segments
}

describe("identidade do card da peça", () => {
  it("a mesma peça endereçada por nome dá a mesma chave", () => {
    expect(pieceCardKeyOf(designWrite("p1", "landing", 1))).toBe(pieceCardKeyOf(designWrite("p2", "landing", 3)))
  })

  it("famílias diferentes com o mesmo nome não se confundem", () => {
    expect(pieceCardKeyOf(designWrite("p1", "peça", 1))).not.toBe(pieceCardKeyOf(motionWrite("p2", "peça")))
  })

  it("uma part que não é de peça não tem chave", () => {
    const read: MessagePart = { id: "p1", type: "tool", tool: "read", state: "done", input: {} }
    expect(pieceCardKeyOf(read)).toBeNull()
  })
})

describe("um card por peça na mesma mensagem", () => {
  it("as telas escritas em chamadas seguidas viram UM card, com o estado final", () => {
    const cards = build([
      designWrite("p1", "landing", 1),
      designWrite("p2", "landing", 2),
      designWrite("p3", "landing", 4),
    ])

    expect(cards).toHaveLength(1)
    // O card fica no lugar da PRIMEIRA chamada: durante o stream ele não pula
    // para baixo, só passa a mostrar o que a última sabe.
    expect(cards[0].id).toBe("p1")
    expect(cards[0].part.id).toBe("p3")
  })

  it("peças diferentes continuam com um card cada", () => {
    const cards = build([
      designWrite("p1", "landing", 1),
      designWrite("p2", "precos", 1),
      designWrite("p3", "landing", 2),
      slidesWrite("p4", "pitch", 8),
    ])

    expect(cards).toHaveLength(3)
    expect(cards.map((c) => c.part.id)).toEqual(["p3", "p2", "p4"])
  })

  it("a chamada sem identidade nenhuma não é engolida por outra", () => {
    // Sem nome, sem caminho e sem relatório não há como dizer de que peça se
    // trata: cada card fica, em vez de sumir dentro de um card alheio.
    const anonymous = (id: string): ToolPart => ({
      id,
      type: "tool",
      tool: "design_write",
      state: "done",
      input: {},
    })

    const cards = build([anonymous("p1"), anonymous("p2")])
    expect(cards).toHaveLength(2)
  })
})
