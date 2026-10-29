import { describe, expect, it } from "vitest"
import { PASTED_HINT_CHARS, pastedTextHint } from "./pasted-text"

describe("pastedTextHint", () => {
  it("usa a primeira linha com conteúdo, sem os espaços em volta", () => {
    expect(pastedTextHint("  Erro ao salvar o pedido\n  at buildToolSet")).toBe("Erro ao salvar o pedido")
  })

  it("pula as linhas em branco do começo", () => {
    expect(pastedTextHint("\n\n   \nContrato de prestação\n\nCláusula 1")).toBe("Contrato de prestação")
  })

  it("tira o que não vale em nome de arquivo", () => {
    expect(pastedTextHint("src/app/foo:bar?baz*qux")).toBe("src app foo bar baz qux")
    expect(pastedTextHint("log\u0000com controle\u001f")).toBe("log com controle")
  })

  it("junta espaços repetidos", () => {
    expect(pastedTextHint("Relatório    de   vendas")).toBe("Relatório de vendas")
  })

  it("corta a linha longa no limite, com reticências", () => {
    const hint = pastedTextHint("a".repeat(PASTED_HINT_CHARS + 20))

    expect(hint).toBe(`${"a".repeat(PASTED_HINT_CHARS)}…`)
  })

  it("não acrescenta reticências quando a linha cabe", () => {
    const exact = "b".repeat(PASTED_HINT_CHARS)

    expect(pastedTextHint(exact)).toBe(exact)
  })

  it("devolve vazio para um texto sem nada aproveitável", () => {
    expect(pastedTextHint("")).toBe("")
    expect(pastedTextHint("   \n\t\n")).toBe("")
    expect(pastedTextHint("///")).toBe("")
  })
})
