import { describe, expect, it } from "vitest"

import { mesmasPastas, pastasDaSessao } from "./session-folders"

describe("pastasDaSessao", () => {
  it("põe a principal na frente das extras", () => {
    expect(
      pastasDaSessao({ directory: "/repo", extraDirectories: ["/shared", "/docs"] }),
    ).toEqual(["/repo", "/shared", "/docs"])
  })

  it("sessão sem pasta não vira lista com string vazia", () => {
    expect(pastasDaSessao({ extraDirectories: ["/shared"] })).toEqual(["/shared"])
    expect(pastasDaSessao({})).toEqual([])
  })
})

describe("mesmasPastas", () => {
  it("mesma principal e mesmas extras são a mesma lista", () => {
    expect(mesmasPastas(["/repo", "/b"], ["/repo", "/b"])).toBe(true)
  })

  it("a ordem entre as extras não conta", () => {
    expect(mesmasPastas(["/repo", "/a", "/b"], ["/repo", "/b", "/a"])).toBe(true)
  })

  it("a principal manda: trocá-la é outra lista", () => {
    expect(mesmasPastas(["/repo", "/a"], ["/outro", "/a"])).toBe(false)
  })

  it("extra associada depois da última gravação é diferença", () => {
    expect(mesmasPastas(["/repo"], ["/repo", "/nova"])).toBe(false)
  })

  it("extra removida é diferença", () => {
    expect(mesmasPastas(["/repo", "/velha"], ["/repo"])).toBe(false)
  })
})
