import { describe, expect, it } from "vitest"
import { summaryBody } from "./summary"

describe("summaryBody", () => {
  it("esconde o cabeçalho do resumo, no formato novo (inglês) e no antigo (português)", () => {
    expect(summaryBody("Summary of the conversation so far:\n\n# Notes")).toBe("# Notes")
    expect(summaryBody("Resumo da conversa até aqui:\n\n# Notas")).toBe("# Notas")
    expect(summaryBody("# Sem cabeçalho")).toBe("# Sem cabeçalho")
  })
})
