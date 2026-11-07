import { describe, expect, it } from "vitest"
import { hasTemplateField, nextTemplateField } from "./template-fields"

describe("nextTemplateField", () => {
  const text = "Create slides about [topic] for [audience], about [10] slides."

  it("finds the first field", () => {
    expect(nextTemplateField(text)).toEqual({ start: 20, end: 27 })
  })

  it("finds the next field after a position", () => {
    expect(nextTemplateField(text, 27)).toEqual({ start: 32, end: 42 })
  })

  it("starts counting at the position, so a caret inside a field skips to the next one", () => {
    expect(nextTemplateField(text, 21)?.start).toBe(32)
  })

  it("returns null when no field is left", () => {
    expect(nextTemplateField(text, 60)).toBeNull()
  })

  it("ignores empty brackets and brackets across lines", () => {
    expect(nextTemplateField("a [] b")).toBeNull()
    expect(nextTemplateField("a [x\ny] b")).toBeNull()
  })
})

describe("hasTemplateField", () => {
  it("tells whether a text still has something to fill", () => {
    expect(hasTemplateField("Write about [topic]")).toBe(true)
    expect(hasTemplateField("Write about cats")).toBe(false)
  })
})
