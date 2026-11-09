import { describe, expect, it } from "vitest"
import { deriveTitle } from "./routine-title"

describe("deriveTitle", () => {
  it("is the first sentence, capitalized", () => {
    expect(deriveTitle("resumir os PRs abertos. Mandar até 10 linhas.")).toBe("Resumir os PRs abertos")
    expect(deriveTitle("  Check the\nprices ")).toBe("Check the")
  })
  it("cuts a long sentence at a word", () => {
    const title = deriveTitle("Todo dia útil de manhã listar os pull requests abertos do repositório e destacar os parados")
    expect(title.endsWith("…")).toBe(true)
    expect(title.length).toBeLessThanOrEqual(49)
    expect(title).not.toMatch(/\s…$/)
  })
  it("is empty for an empty instruction", () => {
    expect(deriveTitle("   ")).toBe("")
  })
})
