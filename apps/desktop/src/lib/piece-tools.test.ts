import { describe, expect, it } from "vitest"
import type { MessagePart, ToolPart } from "@shared/chat"
import { landPieceCard, pieceCardKeyOf } from "./piece-tools"

/** The report the tool returns when registering the canvas (summarized). */
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

/** A card segment as the conversation's segment builder assembles it. */
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

describe("identity of the piece card", () => {
  it("the same piece addressed by name gives the same key", () => {
    expect(pieceCardKeyOf(designWrite("p1", "landing", 1))).toBe(pieceCardKeyOf(designWrite("p2", "landing", 3)))
  })

  it("different families with the same name are not confused", () => {
    expect(pieceCardKeyOf(designWrite("p1", "peça", 1))).not.toBe(pieceCardKeyOf(motionWrite("p2", "peça")))
  })

  it("a part that belongs to no piece has no key", () => {
    const read: MessagePart = { id: "p1", type: "tool", tool: "read", state: "done", input: {} }
    expect(pieceCardKeyOf(read)).toBeNull()
  })
})

describe("one card per piece in the same message", () => {
  it("screens written in consecutive calls become ONE card, with the final state", () => {
    const cards = build([
      designWrite("p1", "landing", 1),
      designWrite("p2", "landing", 2),
      designWrite("p3", "landing", 4),
    ])

    expect(cards).toHaveLength(1)
    // The card stays in place of the FIRST call: during the stream it does not jump
    // down, it just starts showing what the last one knows.
    expect(cards[0].id).toBe("p1")
    expect(cards[0].part.id).toBe("p3")
  })

  it("different pieces keep one card each", () => {
    const cards = build([
      designWrite("p1", "landing", 1),
      designWrite("p2", "precos", 1),
      designWrite("p3", "landing", 2),
      slidesWrite("p4", "pitch", 8),
    ])

    expect(cards).toHaveLength(3)
    expect(cards.map((c) => c.part.id)).toEqual(["p3", "p2", "p4"])
  })

  it("a call with no identity is not swallowed by another", () => {
    // Without a name, without a path and without a report there is no way to say which piece it
    // is: each card stays, instead of vanishing into someone else's card.
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
