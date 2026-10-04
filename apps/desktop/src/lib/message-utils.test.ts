import { describe, expect, it } from "vitest"
import type { MessagePart } from "@shared/chat"
import { arrangeForView } from "./message-utils"

const reasoning = (id: string, text: string, durationMs = 1000): MessagePart => ({
  id,
  type: "reasoning",
  text,
  state: "done",
  durationMs,
})
const tool = (id: string): MessagePart => ({ id, type: "tool", tool: "read", state: "done" })
const text = (id: string, value: string): MessagePart => ({ id, type: "text", text: value, state: "done" })

// Um turno real: pensa, lê, pensa de novo, lê mais, responde.
const turn = [reasoning("r1", "primeiro"), tool("t1"), reasoning("r2", "segundo"), tool("t2"), text("x", "resposta")]

describe("arrangeForView", () => {
  it("resumido: o raciocínio vira um bloco só no topo e as ações se juntam", () => {
    const parts = arrangeForView(turn, "summary")
    expect(parts.map((p) => p.id)).toEqual(["r1", "t1", "t2", "x"])
    expect(parts[0]).toMatchObject({ type: "reasoning", text: "primeiro\n\nsegundo", durationMs: 2000 })
  })

  it("resumido: um bloco ainda sendo escrito mantém o bloco inteiro em andamento", () => {
    const live = [...turn.slice(0, 4), { ...reasoning("r3", "terceiro"), state: "streaming" } as MessagePart]
    expect(arrangeForView(live, "summary")[0]).toMatchObject({ state: "streaming" })
  })

  it("passo a passo e detalhado mantêm a ordem real", () => {
    expect(arrangeForView(turn, "steps")).toBe(turn)
    expect(arrangeForView(turn, "detailed")).toBe(turn)
  })

  it("sem raciocínio, nada muda", () => {
    const plain = [tool("t1"), text("x", "ok")]
    expect(arrangeForView(plain, "summary")).toBe(plain)
  })
})
