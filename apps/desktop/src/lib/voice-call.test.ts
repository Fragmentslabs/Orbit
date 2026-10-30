import { describe, expect, it } from "vitest"
import type { ChatMessage } from "@shared/chat"
import {
  callSpeech,
  captionIndexAt,
  captionLines,
  isCallOwner,
  isSpeech,
  normalizeSpeech,
  speechPieceText,
  speechText,
  spokenPrefix,
  takeSpeakable,
  turnEnded,
} from "./voice-call"

describe("turnEnded", () => {
  it("silence before any speech does not end the turn", () => {
    expect(turnEnded({ heardSpeech: false, lastSpeechAt: 0, now: 10_000, silenceMs: 900 })).toBe(false)
  })

  it("ends only after the configured silence", () => {
    expect(turnEnded({ heardSpeech: true, lastSpeechAt: 1000, now: 1800, silenceMs: 900 })).toBe(false)
    expect(turnEnded({ heardSpeech: true, lastSpeechAt: 1000, now: 1900, silenceMs: 900 })).toBe(true)
  })
})

describe("takeSpeakable", () => {
  it("delivers only complete sentences while the reply arrives", () => {
    const text = "Abre às oito. Fecha às"
    const first = takeSpeakable(text, 0, false)
    expect(first.chunk).toBe("Abre às oito.")
    expect(takeSpeakable(text, first.next, false)).toEqual({ chunk: "", next: first.next })
  })

  it("once the reply is finished, it delivers the rest", () => {
    const text = "Abre às oito. Fecha às dez"
    const first = takeSpeakable(text, 0, false)
    expect(takeSpeakable(text, first.next, true).chunk).toBe("Fecha às dez")
  })

  it("does not cut a decimal number in half", () => {
    expect(takeSpeakable("Custa 3.50 reais", 0, false).chunk).toBe("")
  })
})

describe("spokenPrefix", () => {
  it("reveals the text in proportion to the audio, always at the end of a word", () => {
    expect(spokenPrefix("Primeira frase dita.", 0)).toBe("")
    expect(spokenPrefix("Primeira frase dita.", 0.5)).toBe("Primeira frase")
    expect(spokenPrefix("Primeira frase dita.", 1)).toBe("Primeira frase dita.")
  })

  it("at the end, it shows the last whole word instead of cutting it", () => {
    expect(spokenPrefix("Uma frase", 0.9)).toBe("Uma frase")
  })

  it("an invalid fraction reveals nothing", () => {
    expect(spokenPrefix("Uma frase", Number.NaN)).toBe("")
  })
})

describe("speechPieceText", () => {
  it("splits the text by words without overlapping or leaving a gap", () => {
    const text = "Uma frase um pouco maior para dividir"
    const pieces = [0, 1, 2].map((index) => speechPieceText(text, index, 3))
    expect(pieces.join(" ")).toBe(text)
  })

  it("a chunk outside the range returns no text", () => {
    expect(speechPieceText("Uma frase", 3, 3)).toBe("")
    expect(speechPieceText("", 0, 2)).toBe("")
  })
})

describe("captionLines", () => {
  it("cuts into short lines, always at the end of a word", () => {
    const normalized = normalizeSpeech("A primeira linha tem um tamanho curto e a segunda continua.")
    const lines = captionLines(normalized, 20)
    expect(lines.map((line) => line.text)).toEqual([
      "A primeira linha tem",
      "um tamanho curto e a",
      "segunda continua.",
    ])
    expect(lines.every((line) => line.text.length <= 20)).toBe(true)
    for (const line of lines) expect(normalized.slice(line.start, line.end).trim()).toBe(line.text)
  })

  it("normalizes breaks and spaces before measuring", () => {
    expect(normalizeSpeech("  Uma   frase\ncom   espaços  ")).toBe("Uma frase com espaços")
    expect(captionLines("  Uma   frase\ncom   espaços  ", 10).map((line) => line.text)).toEqual([
      "Uma frase",
      "com",
      "espaços",
    ])
  })

  it("empty text does not become a line", () => {
    expect(captionLines("", 20)).toEqual([])
    expect(captionLines("   \n ", 20)).toEqual([])
  })
})

describe("captionIndexAt", () => {
  it("the next line only takes over when its first letter starts", () => {
    const lines = captionLines("A primeira linha tem um tamanho curto e a segunda continua.", 20)
    expect(captionIndexAt(lines, 0)).toBe(0)
    expect(captionIndexAt(lines, 20)).toBe(0)
    expect(captionIndexAt(lines, 21)).toBe(1)
    expect(captionIndexAt(lines, 41)).toBe(1)
    expect(captionIndexAt(lines, 42)).toBe(2)
    expect(captionIndexAt(lines, 1000)).toBe(2)
  })
})

describe("speechText", () => {
  it("strips the formatting and whatever only makes sense on screen", () => {
    const md = "## Resumo\n- **Abre** às 8\n- veja [o site](https://x.com)\n```js\nconst a = 1\n```\nFim `ok`"
    expect(speechText(md)).toBe("Resumo\nAbre às 8\nveja o site\nFim ok")
  })
})

describe("callSpeech", () => {
  const msg = (parts: unknown[]) => ({ id: "m", role: "assistant", createdAt: 0, parts }) as unknown as ChatMessage

  it("with no tools, the whole reply is the lead (spoken while streaming)", () => {
    const speech = callSpeech(msg([{ type: "reasoning", text: "pensando" }, { type: "text", text: "Abre às oito." }]))
    expect(speech).toEqual({ lead: "Abre às oito.", hasTool: false, final: null })
  })

  it("with tools, the narration in the middle is not spoken; the ending is", () => {
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
    // The waiting sentence stays complete (the tool closed it) and goes to the speech right away.
    expect(takeSpeakable(speech.lead, 0, false).chunk).toBe("Deixa eu pesquisar isso.")
    expect(speech.final).toBe("Abre às oito e fecha às dez.")
  })

  it("the compaction summary is never spoken", () => {
    const summary = { ...msg([{ type: "text", text: "Summary of the conversation so far:\n\nUser prefers brief replies." }]), summary: true }
    expect(callSpeech(summary as ChatMessage)).toEqual({ lead: "", hasTool: false, final: null })
  })

  it("ended on a tool: there is no final reply to speak", () => {
    expect(callSpeech(msg([{ type: "text", text: "Vou ver." }, { type: "tool", tool: "x" }])).final).toBeNull()
  })

  it("engine text does not count, and reasoning leaked into <think> disappears", () => {
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
  it("starting requires more volume than continuing (hysteresis)", () => {
    expect(isSpeech(0.25, false)).toBe(false)
    expect(isSpeech(0.25, true)).toBe(true)
    expect(isSpeech(0.1, true)).toBe(false)
  })

  it("in a noisy room, continuing requires getting above the noise", () => {
    // Noise of 0.2: the continuation threshold goes up to 0.32.
    expect(isSpeech(0.25, true, 0.2)).toBe(false)
    expect(isSpeech(0.33, true, 0.2)).toBe(true)
    // Never above the starting threshold.
    expect(isSpeech(0.35, true, 0.9)).toBe(true)
  })
})

describe("isCallOwner", () => {
  it("only the owner session is the owner", () => {
    expect(isCallOwner({ callSessionId: "s1", sessionId: "s1" })).toBe(true)
    expect(isCallOwner({ callSessionId: "s1", sessionId: "s2" })).toBe(false)
    expect(isCallOwner({ callSessionId: "s1", sessionId: undefined })).toBe(false)
    expect(isCallOwner({ callSessionId: null, sessionId: "s1" })).toBe(false)
  })
})
