import { describe, expect, it } from "vitest"
import type { ChatMessage, MessagePart } from "@shared/chat"
import { assistantView } from "./overlay-answer"

const text = (value: string, source?: "internal" | "nudge"): MessagePart => ({ id: value.slice(0, 6), type: "text", text: value, state: "done", ...(source ? { source } : {}) }) as MessagePart
const tool = (name: string): MessagePart => ({ id: `t_${name}`, type: "tool", tool: name, state: "done" }) as MessagePart
const message = (...parts: MessagePart[]): ChatMessage[] => [{ id: "m", role: "assistant", createdAt: 10, parts } as unknown as ChatMessage]

describe("assistantView", () => {
  it("with no tools, the text is the reply, as it arrives", () => {
    expect(assistantView(message(text("Oi, tudo bem.")), 0, true)).toEqual({ final: "Oi, tudo bem.", progress: "" })
  })

  it("working: only the last narration, in gray — the reply does not exist yet", () => {
    const view = assistantView(message(text("Deixa eu ver."), tool("cu_apps"), text("Vou trazer o Notas pra frente."), tool("cu_computer")), 0, true)
    expect(view).toEqual({ final: "", progress: "Vou trazer o Notas pra frente." })
  })

  it("finished: only the final message, without the narration stuck to it", () => {
    const view = assistantView(
      message(text("Vou trazer o Notas pra frente."), tool("cu_computer"), text("Pronto, a nota está em inglês.")),
      0,
      false,
    )
    expect(view).toEqual({ final: "Pronto, a nota está em inglês.", progress: "" })
  })

  it("finished with no text after the last tool: the last narration counts", () => {
    expect(assistantView(message(text("Feito."), tool("cu_computer")), 0, false).final).toBe("Feito.")
  })

  it("internal engine text and escaped reasoning do not show up", () => {
    const view = assistantView(message(text("Nada a corrigir.", "internal"), text("<think>hmm</think>Resposta.")), 0, false)
    expect(view.final).toBe("Resposta.")
  })

  it("a reply from before the current question does not reappear", () => {
    expect(assistantView(message(text("velha")), 20, false)).toEqual({ final: "", progress: "" })
  })
})
