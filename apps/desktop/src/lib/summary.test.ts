import { describe, expect, it } from "vitest"
import { summaryBody } from "./summary"

describe("summaryBody", () => {
  it("hides the summary header, in the new format (English) and the old one (Portuguese)", () => {
    expect(summaryBody("Summary of the conversation so far:\n\n# Notes")).toBe("# Notes")
    expect(summaryBody("Resumo da conversa até aqui:\n\n# Notas")).toBe("# Notas")
    expect(summaryBody("# Sem cabeçalho")).toBe("# Sem cabeçalho")
  })
})
