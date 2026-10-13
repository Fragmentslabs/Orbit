import { describe, expect, it } from "vitest"
import type { ChatMessage } from "@shared/chat"
import { callSpeech, isSpeech, speechText, takeSpeakable, turnEnded } from "./voice-call"

describe("turnEnded", () => {
  it("silêncio antes de qualquer fala não encerra a vez", () => {
    expect(turnEnded({ heardSpeech: false, lastSpeechAt: 0, now: 10_000, silenceMs: 900 })).toBe(false)
  })

  it("encerra só depois do silêncio configurado", () => {
    expect(turnEnded({ heardSpeech: true, lastSpeechAt: 1000, now: 1800, silenceMs: 900 })).toBe(false)
    expect(turnEnded({ heardSpeech: true, lastSpeechAt: 1000, now: 1900, silenceMs: 900 })).toBe(true)
  })
})

describe("takeSpeakable", () => {
  it("só entrega frases completas enquanto a resposta chega", () => {
    const text = "Abre às oito. Fecha às"
    const first = takeSpeakable(text, 0, false)
    expect(first.chunk).toBe("Abre às oito.")
    expect(takeSpeakable(text, first.next, false)).toEqual({ chunk: "", next: first.next })
  })

  it("com a resposta terminada, entrega o resto", () => {
    const text = "Abre às oito. Fecha às dez"
    const first = takeSpeakable(text, 0, false)
    expect(takeSpeakable(text, first.next, true).chunk).toBe("Fecha às dez")
  })

  it("não corta número decimal no meio", () => {
    expect(takeSpeakable("Custa 3.50 reais", 0, false).chunk).toBe("")
  })
})

describe("speechText", () => {
  it("tira a formatação e o que só faz sentido na tela", () => {
    const md = "## Resumo\n- **Abre** às 8\n- veja [o site](https://x.com)\n```js\nconst a = 1\n```\nFim `ok`"
    expect(speechText(md)).toBe("Resumo\nAbre às 8\nveja o site\nFim ok")
  })
})

describe("callSpeech", () => {
  const msg = (parts: unknown[]) => ({ id: "m", role: "assistant", createdAt: 0, parts }) as unknown as ChatMessage

  it("sem ferramentas, a resposta inteira é o lead (falado em streaming)", () => {
    const speech = callSpeech(msg([{ type: "reasoning", text: "pensando" }, { type: "text", text: "Abre às oito." }]))
    expect(speech).toEqual({ lead: "Abre às oito.", hasTool: false, final: null })
  })

  it("com ferramentas, a narração do meio não é falada; o final, sim", () => {
    const speech = callSpeech(
      msg([
        { type: "text", text: "Deixa eu pesquisar isso." },
        { type: "tool", tool: "web_search" },
        { type: "text", text: "Agora vou ler o primeiro resultado com calma." },
        { type: "tool", tool: "web_fetch" },
        { type: "reasoning", text: "ok" },
        { type: "text", text: "Abre às oito e fecha às dez." },
      ]),
    )
    expect(speech.hasTool).toBe(true)
    // A frase de espera fica completa (a ferramenta a fechou) e vai para a fala na hora.
    expect(takeSpeakable(speech.lead, 0, false).chunk).toBe("Deixa eu pesquisar isso.")
    expect(speech.final).toBe("Abre às oito e fecha às dez.")
  })

  it("o resumo da compactação nunca é falado", () => {
    const summary = { ...msg([{ type: "text", text: "Summary of the conversation so far:\n\nUser prefers brief replies." }]), summary: true }
    expect(callSpeech(summary as ChatMessage)).toEqual({ lead: "", hasTool: false, final: null })
  })

  it("terminou numa ferramenta: não há resposta final para falar", () => {
    expect(callSpeech(msg([{ type: "text", text: "Vou ver." }, { type: "tool", tool: "x" }])).final).toBeNull()
  })

  it("texto do engine não conta, e raciocínio vazado em <think> some", () => {
    const speech = callSpeech(
      msg([
        { type: "text", text: "nudge interno", source: "nudge" },
        { type: "text", text: "<think>preciso checar a agenda</think>Abre às oito. <think>talvez" },
      ]),
    )
    expect(speech.lead).toBe("Abre às oito. ")
  })
})

describe("isSpeech", () => {
  it("começar exige mais volume do que continuar (histerese)", () => {
    expect(isSpeech(0.25, false)).toBe(false)
    expect(isSpeech(0.25, true)).toBe(true)
    expect(isSpeech(0.1, true)).toBe(false)
  })

  it("com a sala barulhenta, continuar exige passar do ruído", () => {
    // Ruído de 0,2: o limiar de continuar sobe para 0,32.
    expect(isSpeech(0.25, true, 0.2)).toBe(false)
    expect(isSpeech(0.33, true, 0.2)).toBe(true)
    // Nunca acima do limiar de começar.
    expect(isSpeech(0.35, true, 0.9)).toBe(true)
  })
})
