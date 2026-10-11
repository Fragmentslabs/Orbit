import { describe, expect, it } from "vitest"
import {
  formatMessageReply,
  messageReplyPrefix,
  parseMessageReply,
  replyExcerpt,
  replySnippet,
} from "@shared/chat"

/**
 * O formato da resposta é contrato entre o texto GRAVADO (a bolha e a cópia da
 * mensagem) e o que o modelo lê. Se a ida e a volta divergirem, a citação
 * aparece no corpo da mensagem como texto cru — o pior jeito de errar, porque
 * o modelo passa a ler "> [assistant]" como se fosse o pedido da pessoa.
 */

describe("formatMessageReply", () => {
  it("marca quem escreveu e cita cada linha", () => {
    expect(formatMessageReply({ role: "assistant", text: "linha 1\nlinha 2" })).toBe(
      "> [assistant] linha 1\n> linha 2",
    )
  })

  it("mantém a linha vazia dentro da citação", () => {
    expect(formatMessageReply({ role: "user", text: "a\n\nb" })).toBe("> [user] a\n>\n> b")
  })
})

describe("parseMessageReply", () => {
  it("separa a citação do corpo", () => {
    const text = `${formatMessageReply({ role: "assistant", text: "o prazo é de 12 meses" })}\n\ne esse prazo vale?`
    expect(parseMessageReply(text)).toEqual({
      reply: { role: "assistant", text: "o prazo é de 12 meses" },
      body: "e esse prazo vale?",
    })
  })

  it("volta igual ao que foi formatado, com quebras de linha", () => {
    const quote = { role: "assistant" as const, text: "primeira\n\nterceira" }
    expect(parseMessageReply(messageReplyPrefix(quote) + "ok").reply).toEqual(quote)
  })

  it("mensagem sem citação volta inteira", () => {
    expect(parseMessageReply("só o meu texto")).toEqual({ reply: null, body: "só o meu texto" })
  })

  it("citação escrita à mão não vira resposta", () => {
    // O usuário pode escrever um `>` por conta própria: sem o marcador, é
    // texto dele e a bolha não deve fingir que é citação de mensagem.
    expect(parseMessageReply("> uma citação qualquer")).toEqual({
      reply: null,
      body: "> uma citação qualquer",
    })
  })

  it("resposta sem corpo não perde a citação", () => {
    expect(parseMessageReply(formatMessageReply({ role: "user", text: "trecho" }))).toEqual({
      reply: { role: "user", text: "trecho" },
      body: "",
    })
  })
})

describe("replyExcerpt", () => {
  it("apara as pontas", () => {
    expect(replyExcerpt("  texto  ")).toBe("texto")
  })

  it("corta no teto e sinaliza que cortou", () => {
    const excerpt = replyExcerpt("a".repeat(50), 10)
    expect(excerpt).toBe(`${"a".repeat(10)}…`)
  })
})

describe("replySnippet", () => {
  it("junta tudo numa linha", () => {
    expect(replySnippet("uma\nfrase   longa")).toBe("uma frase longa")
  })
})
