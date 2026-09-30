import { describe, expect, it } from "vitest"
import { firstLine } from "./document-preview"

/**
 * A linha que o card mostra embaixo do título é tudo que a conversa guarda do
 * conteúdo do documento — tem que ser texto de verdade, não o título de novo
 * nem marcação crua.
 */
describe("firstLine", () => {
  it("pula o título e a régua e devolve o primeiro parágrafo", () => {
    expect(firstLine("# Prova de Matemática\n\n---\n\nLeia com atenção.")).toBe("Leia com atenção.")
  })

  it("tira a marcação que apareceria crua", () => {
    expect(firstLine("> **Escola:** veja o [manual](https://x.com) e `anexo`")).toBe(
      "Escola: veja o manual e anexo",
    )
  })

  it("devolve os underscores escapados como o leitor os vê", () => {
    expect(firstLine("**Data:** \\_\\_/\\_\\_/\\_\\_")).toBe("Data: __/__/__")
  })

  it("corta frase longa", () => {
    const longa = "a".repeat(200)
    expect(firstLine(longa)).toBe(`${"a".repeat(110)}…`)
  })

  it("documento só com título não tem linha para mostrar", () => {
    expect(firstLine("# Só o título\n\n\\pagebreak\n")).toBeNull()
  })
})
