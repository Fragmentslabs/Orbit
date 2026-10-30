import { describe, expect, it } from "vitest"
import {
  formatMessageReply,
  messageReplyPrefix,
  parseMessageReply,
  replyExcerpt,
  replySnippet,
} from "@shared/chat"

/**
 * The reply format is a contract between the SAVED text (the bubble and the copy of the
 * message) and what the model reads. If the round trip diverges, the citation
 * shows up in the message body as raw text — the worst way to get it wrong, because
 * the model starts reading "> [assistant]" as if it were the person's request.
 */

describe("formatMessageReply", () => {
  it("marks who wrote it and quotes each line", () => {
    expect(formatMessageReply({ role: "assistant", text: "linha 1\nlinha 2" })).toBe(
      "> [assistant] linha 1\n> linha 2",
    )
  })

  it("keeps the blank line inside the quote", () => {
    expect(formatMessageReply({ role: "user", text: "a\n\nb" })).toBe("> [user] a\n>\n> b")
  })
})

describe("parseMessageReply", () => {
  it("separates the quote from the body", () => {
    const text = `${formatMessageReply({ role: "assistant", text: "o prazo é de 12 meses" })}\n\ne esse prazo vale?`
    expect(parseMessageReply(text)).toEqual({
      reply: { role: "assistant", text: "o prazo é de 12 meses" },
      body: "e esse prazo vale?",
    })
  })

  it("comes back the same as what was formatted, with line breaks", () => {
    const quote = { role: "assistant" as const, text: "primeira\n\nterceira" }
    expect(parseMessageReply(messageReplyPrefix(quote) + "ok").reply).toEqual(quote)
  })

  it("a message with no quote comes back whole", () => {
    expect(parseMessageReply("só o meu texto")).toEqual({ reply: null, body: "só o meu texto" })
  })

  it("a hand-written quote does not become a reply", () => {
    // The user may write a `>` on their own: without the marker, it is
    // their text and the bubble must not pretend it is a message citation.
    expect(parseMessageReply("> uma citação qualquer")).toEqual({
      reply: null,
      body: "> uma citação qualquer",
    })
  })

  it("a reply with no body does not lose the quote", () => {
    expect(parseMessageReply(formatMessageReply({ role: "user", text: "trecho" }))).toEqual({
      reply: { role: "user", text: "trecho" },
      body: "",
    })
  })
})

describe("replyExcerpt", () => {
  it("trims the edges", () => {
    expect(replyExcerpt("  texto  ")).toBe("texto")
  })

  it("cuts at the cap and signals that it cut", () => {
    const excerpt = replyExcerpt("a".repeat(50), 10)
    expect(excerpt).toBe(`${"a".repeat(10)}…`)
  })
})

describe("replySnippet", () => {
  it("joins everything into one line", () => {
    expect(replySnippet("uma\nfrase   longa")).toBe("uma frase longa")
  })
})
