import { describe, expect, it } from "vitest"
import { DOCUMENT_QUOTE_MIME } from "@shared/chat"
import type { DocumentQuote } from "@/src/stores/panel-store"
import { locateLines, quoteLocationLabel, quotesToFileParts } from "./document-quote"

/**
 * O formato é contrato entre três lugares: os dois compositores, que
 * serializam, e o engine, que desserializa num `if` só. Se a coordenada sair
 * errada daqui, a citação leva a pessoa para a linha errada do documento — e
 * com cara de certeza, que é o pior jeito de errar.
 */

const base: DocumentQuote = {
  id: "q1",
  docId: "doc7",
  name: "contrato.pdf",
  text: "o prazo de vigência é de 12 meses",
}

describe("quoteLocationLabel", () => {
  it("dá o intervalo quando o trecho passa de uma linha", () => {
    expect(quoteLocationLabel({ ...base, page: 3, fromLine: 10, toLine: 14 })).toBe(" p3L10-14")
  })

  it("omite o fim quando começa e termina na mesma linha", () => {
    expect(quoteLocationLabel({ ...base, page: 3, fromLine: 10, toLine: 10 })).toBe(" p3L10")
  })

  it("fica só na página quando não há linha", () => {
    expect(quoteLocationLabel({ ...base, page: 3 })).toBe(" p3")
  })

  it("não inventa coordenada para documento sem página", () => {
    expect(quoteLocationLabel(base)).toBe("")
  })
})

describe("quotesToFileParts", () => {
  it("leva o trecho e a coordenada no payload, e o rótulo no nome", () => {
    const [part] = quotesToFileParts([{ ...base, page: 3, fromLine: 10, toLine: 14 }])
    expect(part.mime).toBe(DOCUMENT_QUOTE_MIME)
    expect(part.filename).toBe("contrato.pdf p3L10-14")

    const payload = JSON.parse(decodeURIComponent(part.url.split(",")[1]))
    expect(payload).toMatchObject({
      docId: "doc7",
      name: "contrato.pdf",
      page: 3,
      fromLine: 10,
      toLine: 14,
      text: base.text,
    })
  })

  it("um documento sem página vai só com o texto", () => {
    const [part] = quotesToFileParts([base])
    const payload = JSON.parse(decodeURIComponent(part.url.split(",")[1]))
    expect(part.filename).toBe("contrato.pdf")
    expect(payload.page).toBeUndefined()
    expect(payload.text).toBe(base.text)
  })
})

describe("locateLines", () => {
  const pagina = [
    "CLÁUSULA QUARTA — DA VIGÊNCIA",
    "O prazo de vigência do presente contrato",
    "é de 12 (doze) meses, contados da assinatura.",
    "Parágrafo único: a renovação é automática.",
  ]

  it("acha o trecho e devolve a linha", () => {
    expect(locateLines(pagina, "é de 12 (doze) meses")).toEqual({ fromLine: 3, toLine: undefined })
  })

  it("devolve o intervalo quando o trecho atravessa linhas", () => {
    // É o caso normal no PDF: a frase que a pessoa grifa raramente cabe numa
    // linha só do texto extraído.
    expect(locateLines(pagina, "do presente contrato é de 12")).toEqual({ fromLine: 2, toLine: 3 })
  })

  it("ignora as diferenças de espaço entre o desenho e o texto", () => {
    // Na camada do PDF a frase chega partida em pedaços de glifo, e os espaços
    // entre eles não são confiáveis.
    expect(locateLines(pagina, "ren  ovação   é auto mática")).toEqual({
      fromLine: 4,
      toLine: undefined,
    })
  })

  it("devolve null quando o trecho não está na página", () => {
    expect(locateLines(pagina, "rescisão antecipada")).toBeNull()
  })

  it("não tenta adivinhar com uma letra só", () => {
    expect(locateLines(pagina, "a")).toBeNull()
  })
})
