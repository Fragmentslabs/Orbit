import { describe, expect, it } from "vitest"
import { DOCUMENT_QUOTE_MIME, formatMotionQuoteText, type MotionQuotePayload } from "@shared/chat"
import type { DocumentQuote, MotionQuote } from "@/src/stores/panel-store"
import { locateLines, quoteChipLabel, quoteLocationLabel, quotesToFileParts } from "./document-quote"

/**
 * O formato é contrato entre três lugares: os dois compositores, que
 * serializam, e o engine, que desserializa num `if` só. Se a coordenada sair
 * errada daqui, a citação leva a pessoa para a linha errada do documento — e
 * com cara de certeza, que é o pior jeito de errar.
 */

const base: DocumentQuote = {
  id: "q1",
  kind: "source",
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
      kind: "source",
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

const instante: MotionQuote = {
  id: "m1",
  kind: "motion",
  file: "res/cartela/index.html",
  name: "Cartela de abertura",
  // 2,30 s a 30 fps = quadro 69. É o caso que o usuário confere no app: o
  // playhead parado no 2,30 s tem de chegar no chat como 00:02:09.
  frame: 69,
  fps: 30,
}

describe("quoteChipLabel", () => {
  it("o instante vira `Motion · arquivo @ mm:ss:ff`", () => {
    expect(quoteChipLabel(instante)).toBe("Motion · index.html @ 00:02:09")
  })

  it("o trecho de documento continua com a coordenada", () => {
    expect(quoteChipLabel({ ...base, page: 3, fromLine: 10, toLine: 14 })).toBe("contrato.pdf p3L10-14")
  })
})

describe("quotesToFileParts de um instante de motion", () => {
  it("leva arquivo, quadro e fps — e nenhuma chave de página/linha", () => {
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
    // A citação de motion não tem página nem linha: a chave ausente é o
    // contrato, e uma chave vazia aqui viraria campo órfão no texto do modelo.
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

  it("anexo completo: arquivo, quadro, fps e os segundos com vírgula", () => {
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

  it("com o usuário sem escrever nada, o texto termina limpo", () => {
    // Sem texto não entra o `---` nem sobra linha vazia no fim: o anexo sai
    // inteiro e sem separador órfão.
    const semTexto = formatMotionQuoteText(payload, "")
    expect(semTexto).toBe(formatMotionQuoteText(payload, undefined))
    expect(semTexto.endsWith("(00:02:09)")).toBe(true)
    expect(semTexto).not.toContain("---")
    expect(semTexto.trim()).toBe(semTexto)
  })

  it("com caminho, camada e o que está em cena: o endereço completo e o elemento apontado", () => {
    const texto = formatMotionQuoteText(
      { ...payload, path: "C:/proj/res/cartela/index.html", layer: "title", onScreen: ["bg", "title"] },
      "entra rápido demais",
    )
    expect(texto).toContain("File: C:/proj/res/cartela/index.html")
    expect(texto).toContain("Selected layer: title")
    expect(texto).toContain("On screen at this frame: bg, title")
    // A nota do usuário continua por último, depois do separador.
    expect(texto.endsWith("---\nentra rápido demais")).toBe(true)
  })

  it("com uma faixa de som em foco, o agente lê som — não uma camada", () => {
    // O som da peça toca FORA do palco (ver motion-audio.ts): chamá-lo de camada
    // mandaria o agente procurar no DOM um elemento com o nome da trilha, e não
    // existe nenhum. São campos distintos de propósito.
    const texto = formatMotionQuoteText({ ...payload, audio: "Cama roxa (cartão 3)" }, "abaixa essa cama")
    expect(texto).toContain("Selected audio track: Cama roxa (cartão 3)")
    expect(texto).not.toContain("Selected layer")
  })

  it("não sobra campo de página/linha no texto do modelo", () => {
    const texto = formatMotionQuoteText(payload, "aumente o contraste")
    expect(texto).not.toMatch(/\b(page|line|página|linha)\b/i)
    expect(texto).not.toContain("undefined")
    expect(texto).not.toContain("null")
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
