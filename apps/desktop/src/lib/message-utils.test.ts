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

  // Turno real de hoje: pensa, narra ("pensando alto"), roda ações, pensa de
  // novo, responde e ainda fecha com a checagem interna do engine.
  const narrado = [
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

  it("resumido: a narração intermediária sai e a resposta toma o lugar dela", () => {
    const parts = arrangeForView(narrado, "summary")
    expect(parts.map((p) => p.id)).toEqual(["r1", "x", "t1", "t2", "t3", "e1"])
    expect(parts[0]).toMatchObject({
      type: "reasoning",
      text: "primeiro\n\nsegundo\n\nchecagem",
      durationMs: 3000,
    })
  })

  it("resumido: sem narração a resposta fica onde estava", () => {
    const direto = [tool("t1"), tool("t2"), text("x", "resposta")]
    expect(arrangeForView(direto, "summary")).toBe(direto)
  })

  it("resumido: turno que termina pensando não perde o texto", () => {
    const terminaPensando = [
      text("x", "resposta"),
      tool("t1"),
      reasoning("r1", "checagem"),
      reasoning("r2", "mais checagem"),
    ]
    expect(arrangeForView(terminaPensando, "summary").map((p) => p.id)).toEqual(["r1", "x", "t1"])
  })

  it("resumido: texto do engine não é narração nem resposta", () => {
    const comNudge = [
      reasoning("r1", "primeiro"),
      text("n1", "narração"),
      tool("t1"),
      text("x", "resposta"),
      text("d1", "linha do engine", "todo"),
    ]
    expect(arrangeForView(comNudge, "summary").map((p) => p.id)).toEqual(["r1", "x", "t1", "d1"])
  })

  it("passo a passo e detalhado mantêm a narração no lugar", () => {
    expect(arrangeForView(narrado, "steps").map((p) => p.id)).toEqual(narrado.map((p) => p.id))
    expect(arrangeForView(narrado, "detailed").map((p) => p.id)).toEqual(narrado.map((p) => p.id))
  })
})
