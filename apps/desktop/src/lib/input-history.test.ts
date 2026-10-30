import { describe, expect, it } from "vitest"
import type { ChatMessage, MessagePart, MessageReplyQuote } from "@shared/chat"
import {
  historyKeyInput,
  historyStep,
  inputHistory,
  NO_HISTORY,
  type HistoryEntry,
  type HistoryCursor,
} from "@/src/lib/input-history"

function message(role: ChatMessage["role"], ...texts: string[]): ChatMessage {
  const parts: MessagePart[] = texts.map((text, i) => ({ id: `p${i}`, type: "text", text, state: "done" }))
  return { id: `m${Math.random()}`, role, parts, createdAt: 0 }
}

/** Text extracted from an attachment: shows up for the model, not for the person. */
function attachmentText(text: string): MessagePart {
  return { id: "pa", type: "text", text, state: "done", source: "attachment" }
}

const quote: MessageReplyQuote = { role: "assistant", text: "pergunta anterior" }

function cursor(patch: Partial<HistoryCursor> = {}): HistoryCursor {
  return { ...NO_HISTORY, ...patch }
}

describe("inputHistory", () => {
  it("keeps only what the person sent, newest first", () => {
    const history = inputHistory([
      message("user", "primeira"),
      message("assistant", "reply"),
      message("user", "segunda"),
      message("assistant", "outra reply"),
    ])
    expect(history.map((e) => e.text)).toEqual(["segunda", "primeira"])
  })

  it("separates the quote from the body — the marker does not go back into the field", () => {
    const history = inputHistory([
      message("user", "> [assistant] pergunta anterior\n\no que eu perguntei"),
    ])
    expect(history).toEqual([{ text: "o que eu perguntei", reply: quote }])
  })

  it("ignores a message with no text (attachment only) and text extracted from an attachment", () => {
    const history = inputHistory([
      message("user", "texto de verdade"),
      { id: "m1", role: "user", parts: [attachmentText("content do PDF")], createdAt: 0 },
    ])
    expect(history.map((e) => e.text)).toEqual(["texto de verdade"])
  })

  it("does not repeat the same text in a row", () => {
    const history = inputHistory([
      message("user", "de novo"),
      message("user", "de novo"),
      message("user", "before"),
    ])
    // From the most recent to the oldest: "before" came last.
    expect(history.map((e) => e.text)).toEqual(["before", "de novo"])
  })

  it("an empty session has no history", () => {
    expect(inputHistory(undefined)).toEqual([])
    expect(inputHistory([])).toEqual([])
  })
})

describe("historyStep", () => {
  const history: HistoryEntry[] = [
    { text: "more recent", reply: null },
    { text: "anterior", reply: null },
    { text: "more older", reply: null },
  ]

  it("↑ in the first position recovers the most recent and keeps what was typed", () => {
    const step = historyStep(history, NO_HISTORY, { text: "", atStart: true, atEnd: true }, "older", null)
    expect(step?.entry.text).toBe("more recent")
    expect(step?.cursor).toMatchObject({ index: 0, draft: "" })
  })

  it("↑ again, with the caret in the first position, goes down the history", () => {
    const step = historyStep(
      history,
      cursor({ index: 0 }),
      { text: "more recent", atStart: true, atEnd: false },
      "older",
      null,
    )
    expect(step?.entry.text).toBe("anterior")
    expect(step?.cursor.index).toBe(1)
  })

  it("↑ at the top of the list does nothing — the arrow belongs to the caret again", () => {
    expect(
      historyStep(history, cursor({ index: 2 }), { text: "more older", atStart: true, atEnd: false }, "older", null),
    ).toBeNull()
  })

  it("↑ in the middle of a multi-line text belongs to the caret", () => {
    expect(
      historyStep(history, NO_HISTORY, { text: "line 1\nlinha 2", atStart: false, atEnd: false }, "older", null),
    ).toBeNull()
    // And it does not escape the rule while already navigating either: in the middle, the arrow goes up a line.
    expect(
      historyStep(history, cursor({ index: 0 }), { text: "line 1\nlinha 2", atStart: false, atEnd: false }, "older", null),
    ).toBeNull()
  })

  it("↓ in the middle of the text belongs to the caret, even while navigating", () => {
    expect(
      historyStep(history, cursor({ index: 1 }), { text: "line 1\nlinha 2", atStart: false, atEnd: false }, "newer", null),
    ).toBeNull()
  })

  it("↓ in the last position goes back through the history", () => {
    const step = historyStep(
      history,
      cursor({ index: 1 }),
      { text: "anterior", atStart: false, atEnd: true },
      "newer",
      null,
    )
    expect(step?.entry.text).toBe("more recent")
    expect(step?.cursor.index).toBe(0)
  })

  it("↓ going past the most recent returns the draft and the quote", () => {
    const withCitation = cursor({ index: 0, draft: "digitando", reply: quote })
    const step = historyStep(history, withCitation, { text: "more recent", atStart: false, atEnd: true }, "newer", null)
    expect(step?.entry).toEqual({ text: "digitando", reply: quote })
    expect(step?.cursor.index).toBeNull()
  })

  it("↓ outside navigation changes nothing", () => {
    expect(
      historyStep(history, NO_HISTORY, { text: "digitando", atStart: false, atEnd: true }, "newer", null),
    ).toBeNull()
  })

  it("the armed reply goes into the draft when navigation starts", () => {
    const step = historyStep(history, NO_HISTORY, { text: "respondendo", atStart: true, atEnd: false }, "older", quote)
    expect(step?.cursor.reply).toEqual(quote)
  })

  it("edited text does not restart navigation: ↑ keeps going to the oldest", () => {
    const step = historyStep(
      history,
      cursor({ index: 0 }),
      { text: "more recent editada", atStart: true, atEnd: false },
      "older",
      null,
    )
    expect(step?.entry.text).toBe("anterior")
  })

  it("with no history, no arrow is captured", () => {
    expect(historyStep([], NO_HISTORY, { text: "", atStart: true, atEnd: true }, "older", null)).toBeNull()
  })
})

describe("historyKeyInput", () => {
  const twoLines = "linha 1\nlinha 2"

  it("two lines: ↑ is history only with the caret in the FIRST position", () => {
    expect(historyKeyInput({ value: twoLines, selectionStart: 0, selectionEnd: 0 })?.atStart).toBe(true)
    // Caret at the last character of the bottom line: the arrow belongs to the caret.
    expect(historyKeyInput({ value: twoLines, selectionStart: 14, selectionEnd: 14 })).toEqual({
      text: twoLines,
      atStart: false,
      atEnd: false,
    })
  })

  it("text with NO break that only wrapped on screen also requires the edge", () => {
    // Regression: the "single line" exception made ↑ switch messages in the middle
    // of a long text that only takes up two VISUAL lines.
    const wrapped = "um texto comprido que ocupa duas linhas na tela"
    expect(historyKeyInput({ value: wrapped, selectionStart: 10, selectionEnd: 10 })).toEqual({
      text: wrapped,
      atStart: false,
      atEnd: false,
    })
  })

  it("↓ is history only in the last position", () => {
    expect(historyKeyInput({ value: twoLines, selectionStart: twoLines.length, selectionEnd: twoLines.length })?.atEnd).toBe(true)
  })

  it("an empty field is the edge of both", () => {
    expect(historyKeyInput({ value: "", selectionStart: 0, selectionEnd: 0 })).toEqual({
      text: "",
      atStart: true,
      atEnd: true,
    })
  })

  it("with a selection the arrow does not belong to the history", () => {
    expect(historyKeyInput({ value: twoLines, selectionStart: 2, selectionEnd: 9 })).toBeNull()
  })

  it("the text comes from the field, not from the React state", () => {
    const step = historyStep(
      [{ text: "anterior", reply: null }],
      NO_HISTORY,
      historyKeyInput({ value: twoLines, selectionStart: 0, selectionEnd: 0 })!,
      "older",
      null,
    )
    expect(step?.cursor.draft).toBe(twoLines)
  })
})
