import { describe, expect, it } from "vitest"
import { DOCUMENT_QUOTE_MIME, formatMotionQuoteText, formatWidgetQuoteText, type MotionQuotePayload } from "@shared/chat"
import type { DocumentQuote, MotionQuote, WidgetQuote } from "@/src/stores/panel-store"
import { locateLines, quoteChipLabel, quoteLocationLabel, quotesToFileParts } from "./document-quote"

/**
 * The format is a contract between three places: the two composers, which
 * serialize, and the engine, which deserializes in a single `if`. If the coordinate comes out
 * wrong from here, the citation takes the person to the wrong line of the document — and
 * with a look of certainty, which is the worst way to be wrong.
 */

const base: DocumentQuote = {
  id: "q1",
  kind: "source",
  docId: "doc7",
  name: "contrato.pdf",
  text: "o prazo de vigência é de 12 meses",
}

describe("quoteLocationLabel", () => {
  it("gives the range when the excerpt spans more than one line", () => {
    expect(quoteLocationLabel({ ...base, page: 3, fromLine: 10, toLine: 14 })).toBe(" p3L10-14")
  })

  it("omits the end when it starts and ends on the same line", () => {
    expect(quoteLocationLabel({ ...base, page: 3, fromLine: 10, toLine: 10 })).toBe(" p3L10")
  })

  it("stays on the page alone when there is no line", () => {
    expect(quoteLocationLabel({ ...base, page: 3 })).toBe(" p3")
  })

  it("does not invent a coordinate for a document with no page", () => {
    expect(quoteLocationLabel(base)).toBe("")
  })
})

describe("quotesToFileParts", () => {
  it("carries the excerpt and the coordinate in the payload, and the label in the name", () => {
    const [part] = quotesToFileParts([{ ...base, page: 3, fromLine: 10, toLine: 14 }])
    expect(part.mime).toBe(DOCUMENT_QUOTE_MIME)
    expect(part.filename).toBe("contrato.pdf p3L10-14")

    const payload = JSON.parse(decodeURIComponent(part.url.split(",")[1]))
    expect(payload).toMatchObject({
      kind: "source",
      docId: "doc7",
      name: "contrato.pdf",
      page: 3,
      fromLine: 10,
      toLine: 14,
      text: base.text,
    })
  })

  it("a document with no page goes with the text only", () => {
    const [part] = quotesToFileParts([base])
    const payload = JSON.parse(decodeURIComponent(part.url.split(",")[1]))
    expect(part.filename).toBe("contrato.pdf")
    expect(payload.page).toBeUndefined()
    expect(payload.text).toBe(base.text)
  })
})

const instante: MotionQuote = {
  id: "m1",
  kind: "motion",
  file: "res/cartela/index.html",
  name: "Cartela de abertura",
  // 2.30 s at 30 fps = frame 69. It is the case the user checks in the app: the
  // playhead stopped at 2.30 s has to reach the chat as 00:02:09.
  frame: 69,
  fps: 30,
}

describe("quoteChipLabel", () => {
  it("the instant becomes `Motion · file @ mm:ss:ff`", () => {
    expect(quoteChipLabel(instante)).toBe("Motion · index.html @ 00:02:09")
  })

  it("the document excerpt keeps its coordinate", () => {
    expect(quoteChipLabel({ ...base, page: 3, fromLine: 10, toLine: 14 })).toBe("contrato.pdf p3L10-14")
  })
})

describe("quotesToFileParts of a motion instant", () => {
  it("carries file, frame and fps — and no page/line key", () => {
    const [part] = quotesToFileParts([instante])
    expect(part.mime).toBe(DOCUMENT_QUOTE_MIME)
    expect(part.filename).toBe("Motion · index.html @ 00:02:09")

    const payload = JSON.parse(decodeURIComponent(part.url.split(",")[1]))
    expect(payload).toEqual({
      kind: "motion",
      file: "res/cartela/index.html",
      name: "Cartela de abertura",
      frame: 69,
      fps: 30,
    })
    // The motion citation has no page or line: the missing key is the
    // contract, and an empty key here would become an orphan field in the model text.
    expect("page" in payload).toBe(false)
    expect("fromLine" in payload).toBe(false)
    expect("toLine" in payload).toBe(false)
  })
})

describe("formatMotionQuoteText", () => {
  const payload: MotionQuotePayload = {
    kind: "motion",
    file: "res/cartela/index.html",
    name: "Cartela de abertura",
    frame: 69,
    fps: 30,
  }

  it("full attachment: file, frame, fps and the seconds with a comma", () => {
    expect(formatMotionQuoteText(payload, "deixe o título maior")).toBe(
      [
        "[Motion composition — Cartela de abertura]",
        "File: res/cartela/index.html",
        "Frame 69 at 30 fps — 2,30 s (00:02:09)",
        "---",
        "deixe o título maior",
      ].join("\n"),
    )
  })

  it("with the user writing nothing, the text ends clean", () => {
    // Without text the `---` does not go in and no empty line is left at the end: the attachment comes out
    // whole and without an orphan separator.
    const withoutText = formatMotionQuoteText(payload, "")
    expect(withoutText).toBe(formatMotionQuoteText(payload, undefined))
    expect(withoutText.endsWith("(00:02:09)")).toBe(true)
    expect(withoutText).not.toContain("---")
    expect(withoutText.trim()).toBe(withoutText)
  })

  it("with path, layer and what is on stage: the full address and the pointed element", () => {
    const text = formatMotionQuoteText(
      { ...payload, path: "C:/proj/res/cartela/index.html", layer: "title", onScreen: ["bg", "title"] },
      "entra rápido demais",
    )
    expect(text).toContain("File: C:/proj/res/cartela/index.html")
    expect(text).toContain("Selected layer: title")
    expect(text).toContain("On screen at this frame: bg, title")
    // The user note stays last, after the separator.
    expect(text.endsWith("---\nentra rápido demais")).toBe(true)
  })

  it("with an audio track in focus, the agent reads sound — not a layer", () => {
    // The piece's sound plays OUTSIDE the stage (see motion-audio.ts): calling it a layer
    // would send the agent looking in the DOM for an element with the track name, and there
    // is none. They are distinct fields on purpose.
    const text = formatMotionQuoteText({ ...payload, audio: "Cama roxa (cartão 3)" }, "abaixa essa cama")
    expect(text).toContain("Selected audio track: Cama roxa (cartão 3)")
    expect(text).not.toContain("Selected layer")
  })

  it("no page/line field is left in the model's text", () => {
    const text = formatMotionQuoteText(payload, "aumente o contraste")
    expect(text).not.toMatch(/\b(page|line|página|linha)\b/i)
    expect(text).not.toContain("undefined")
    expect(text).not.toContain("null")
  })
})

const widget: WidgetQuote = {
  id: "w1",
  kind: "widget",
  fragmentId: "frag-financas",
  fragmentName: "Finanças",
  widgetId: "resumo",
  name: "Resumo do mês",
  size: "2x1",
  sizes: ["2x2", "2x1", "1x1"],
}

describe("quotesToFileParts of a widget", () => {
  it("carries the fragment and the widget — and no page/line key", () => {
    const [part] = quotesToFileParts([widget])
    expect(part.mime).toBe(DOCUMENT_QUOTE_MIME)
    expect(part.filename).toBe("Widget · Resumo do mês · 2x1")

    // The widget citation addresses a fragment, not a document: leaking page/docId here
    // would send the agent looking for a file that does not exist.
    const payload = JSON.parse(decodeURIComponent(part.url.split(",")[1]))
    expect(payload).toEqual({
      kind: "widget",
      fragmentId: "frag-financas",
      fragmentName: "Finanças",
      widgetId: "resumo",
      name: "Resumo do mês",
      size: "2x1",
      sizes: ["2x2", "2x1", "1x1"],
    })
    expect("page" in payload).toBe(false)
    expect("docId" in payload).toBe(false)
  })
})

describe("formatWidgetQuoteText", () => {
  const payload = {
    kind: "widget" as const,
    fragmentId: "frag-financas",
    fragmentName: "Finanças",
    widgetId: "resumo",
    name: "Resumo do mês",
    size: "2x1",
    sizes: ["2x2", "2x1", "1x1"],
  }

  it("names the widget, its size and the fragment it belongs to", () => {
    const text = formatWidgetQuoteText(payload, "cabe em 1x1?")
    expect(text).toContain('[Fragment widget — "Resumo do mês" at 2x1, from the fragment "Finanças"]')
    expect(text).toContain("Fragment id: frag-financas")
    expect(text).toContain("2x2, 2x1, 1x1")
    expect(text.endsWith("---\ncabe em 1x1?")).toBe(true)
  })

  it("with the user writing nothing, the text ends clean", () => {
    const text = formatWidgetQuoteText(payload)
    expect(text).not.toContain("---")
    expect(text.trim()).toBe(text)
  })
})

describe("locateLines", () => {
  const page = [
    "CLÁUSULA QUARTA — DA VIGÊNCIA",
    "O prazo de vigência do presente contrato",
    "é de 12 (doze) meses, contados da assinatura.",
    "Parágrafo único: a renovação é automática.",
  ]

  it("finds the excerpt and returns the line", () => {
    expect(locateLines(page, "é de 12 (doze) meses")).toEqual({ fromLine: 3, toLine: undefined })
  })

  it("returns the range when the excerpt crosses lines", () => {
    // It is the normal case in a PDF: the sentence the person highlights rarely fits in a
    // single line of the extracted text.
    expect(locateLines(page, "do presente contrato é de 12")).toEqual({ fromLine: 2, toLine: 3 })
  })

  it("ignores the spacing differences between the drawing and the text", () => {
    // In the PDF layer the sentence arrives split into glyph pieces, and the spaces
    // between them are not reliable.
    expect(locateLines(page, "ren  ovação   é auto mática")).toEqual({
      fromLine: 4,
      toLine: undefined,
    })
  })

  it("returns null when the excerpt is not on the page", () => {
    expect(locateLines(page, "rescisão antecipada")).toBeNull()
  })

  it("does not try to guess with a single letter", () => {
    expect(locateLines(page, "a")).toBeNull()
  })
})
