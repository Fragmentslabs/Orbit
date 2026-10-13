import { describe, expect, it } from "vitest"
import { voiceSample } from "./voice-preview-button"

describe("voiceSample", () => {
  it("fala no idioma da leitura, com o inglês para o agnóstico e o desconhecido", () => {
    expect(voiceSample("pt")).toMatch(/^Olá!/)
    expect(voiceSample("es")).toMatch(/^¡Hola!/)
    expect(voiceSample("na")).toBe(voiceSample("en"))
    expect(voiceSample("xx")).toBe(voiceSample("en"))
  })
})
