import { describe, expect, it } from "vitest"
import { voiceSample } from "./voice-preview-button"

describe("voiceSample", () => {
  it("speaks in the reading language, with English for the agnostic and the unknown", () => {
    expect(voiceSample("pt")).toMatch(/^Olá!/)
    expect(voiceSample("es")).toMatch(/^¡Hola!/)
    expect(voiceSample("na")).toBe(voiceSample("en"))
    expect(voiceSample("xx")).toBe(voiceSample("en"))
  })
})
