import { describe, expect, it } from "vitest"
import { INITIAL_TURNS, defaultWindowStart, turnStart, windowStartFor } from "./message-window"

const conv = (pattern: string) => [...pattern].map((c) => ({ role: c === "u" ? "user" : "assistant" }))

describe("message-window", () => {
  it("começa na N-ésima pergunta contando do fim", () => {
    const msgs = conv("uauauaua")
    expect(turnStart(msgs, msgs.length, 1)).toBe(6)
    expect(turnStart(msgs, msgs.length, 2)).toBe(4)
  })

  it("sem turnos suficientes, começa do zero", () => {
    expect(turnStart(conv("aua"), 3, 5)).toBe(0)
    expect(turnStart([], 0, 3)).toBe(0)
  })

  it("estender a partir do início atual soma turnos acima dele", () => {
    const msgs = conv("uauauauaua")
    const start = turnStart(msgs, msgs.length, 2) // 6
    expect(turnStart(msgs, start, 2)).toBe(2)
  })

  it("nunca abre com meia resposta: a janela começa numa mensagem do usuário", () => {
    const msgs = conv("uaaauaaua")
    expect(msgs[turnStart(msgs, msgs.length, 2)].role).toBe("user")
  })

  it("janela padrão monta só os últimos turnos", () => {
    const msgs = conv("ua".repeat(INITIAL_TURNS + 30))
    expect(defaultWindowStart(msgs)).toBe(60)
    expect(msgs.length - defaultWindowStart(msgs)).toBe(INITIAL_TURNS * 2)
  })

  it("revelar uma resposta antiga inclui a pergunta dela", () => {
    const msgs = conv("uauaaua")
    expect(windowStartFor(msgs, 4)).toBe(2)
    expect(windowStartFor(msgs, 2)).toBe(2)
  })
})
