import { describe, expect, it } from "vitest"
import type { MessagePart, TextPart } from "@shared/chat"
import { arrangeForView } from "./message-utils"

const reasoning = (id: string, text: string, durationMs = 1000): MessagePart => ({
  id,
  type: "reasoning",
  text,
  state: "done",
  durationMs,
})
const tool = (id: string): MessagePart => ({ id, type: "tool", tool: "read", state: "done" })
const text = (id: string, value: string, source?: TextPart["source"]): MessagePart => ({
  id,
  type: "text",
  text: value,
  state: "done",
  ...(source ? { source } : {}),
})

// A real turn: thinks, reads, thinks again, reads more, answers.
const turn = [reasoning("r1", "primeiro"), tool("t1"), reasoning("r2", "segundo"), tool("t2"), text("x", "resposta")]

describe("arrangeForView", () => {
  it("summarized: the reasoning becomes a single block at the top and the actions merge", () => {
    const parts = arrangeForView(turn, "summary")
    expect(parts.map((p) => p.id)).toEqual(["r1", "t1", "t2", "x"])
    expect(parts[0]).toMatchObject({ type: "reasoning", text: "primeiro\n\nsegundo", durationMs: 2000 })
  })

  it("summarized: a block still being written keeps the whole block in progress", () => {
    const live = [...turn.slice(0, 4), { ...reasoning("r3", "terceiro"), state: "streaming" } as MessagePart]
    expect(arrangeForView(live, "summary")[0]).toMatchObject({ state: "streaming" })
  })

  it("step by step and detailed keep the real order", () => {
    expect(arrangeForView(turn, "steps")).toBe(turn)
    expect(arrangeForView(turn, "detailed")).toBe(turn)
  })

  it("with no reasoning, nothing changes", () => {
    const plain = [tool("t1"), text("x", "ok")]
    expect(arrangeForView(plain, "summary")).toBe(plain)
  })

  // A real turn from today: thinks, narrates ("thinking out loud"), runs actions, thinks
  // again, answers and still closes with the engine's internal check.
  const narrated = [
    reasoning("r1", "primeiro"),
    text("n1", "deixa eu conferir o disco"),
    tool("t1"),
    tool("t2"),
    reasoning("r2", "segundo"),
    tool("t3"),
    text("x", "resposta"),
    reasoning("r3", "checagem"),
    text("e1", "nada a corrigir", "internal"),
  ]

  it("summarized: the middle narration goes out and the reply takes its place", () => {
    const parts = arrangeForView(narrated, "summary")
    expect(parts.map((p) => p.id)).toEqual(["r1", "x", "t1", "t2", "t3", "e1"])
    expect(parts[0]).toMatchObject({
      type: "reasoning",
      text: "primeiro\n\nsegundo\n\nchecagem",
      durationMs: 3000,
    })
  })

  it("summarized: with no narration the reply stays where it was", () => {
    const direct = [tool("t1"), tool("t2"), text("x", "resposta")]
    expect(arrangeForView(direct, "summary")).toBe(direct)
  })

  it("summarized: a turn that ends thinking does not lose the text", () => {
    const endsThinking = [
      text("x", "resposta"),
      tool("t1"),
      reasoning("r1", "checagem"),
      reasoning("r2", "mais checagem"),
    ]
    expect(arrangeForView(endsThinking, "summary").map((p) => p.id)).toEqual(["r1", "x", "t1"])
  })

  it("summarized: engine text is neither narration nor reply", () => {
    const withNudge = [
      reasoning("r1", "primeiro"),
      text("n1", "narração"),
      tool("t1"),
      text("x", "resposta"),
      text("d1", "linha do engine", "todo"),
    ]
    expect(arrangeForView(withNudge, "summary").map((p) => p.id)).toEqual(["r1", "x", "t1", "d1"])
  })

  it("step by step and detailed keep the narration in place", () => {
    expect(arrangeForView(narrated, "steps").map((p) => p.id)).toEqual(narrated.map((p) => p.id))
    expect(arrangeForView(narrated, "detailed").map((p) => p.id)).toEqual(narrated.map((p) => p.id))
  })
})
