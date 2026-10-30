import { describe, expect, it } from "vitest"
import { firstLine } from "./document-preview"

/**
 * The line the card shows under the title is everything the conversation keeps of the
 * document content — it has to be real text, not the title again
 * nor raw markup.
 */
describe("firstLine", () => {
  it("skips the title and the rule and returns the first paragraph", () => {
    expect(firstLine("# Prova de Matemática\n\n---\n\nLeia com atenção.")).toBe("Leia com atenção.")
  })

  it("strips the markup that would show up raw", () => {
    expect(firstLine("> **Escola:** veja o [manual](https://x.com) e `anexo`")).toBe(
      "Escola: veja o manual e anexo",
    )
  })

  it("returns escaped underscores as the reader sees them", () => {
    expect(firstLine("**Data:** \\_\\_/\\_\\_/\\_\\_")).toBe("Data: __/__/__")
  })

  it("corta frase longa", () => {
    const longa = "a".repeat(200)
    expect(firstLine(longa)).toBe(`${"a".repeat(110)}…`)
  })

  it("a document with only a title has no line to show", () => {
    expect(firstLine("# Só o título\n\n\\pagebreak\n")).toBeNull()
  })
})
