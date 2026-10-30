import { describe, expect, it } from "vitest"
import { numberOf, stripPx, toCssLength } from "./design-controls"

describe("panel values", () => {
  it("stripPx strips only the px from numbers", () => {
    expect(stripPx("12px")).toBe("12")
    expect(stripPx("-4.5px")).toBe("-4.5")
    expect(stripPx("1rem")).toBe("1rem")
    expect(stripPx("50%")).toBe("50%")
    expect(stripPx("auto")).toBe("auto")
  })

  it("toCssLength adds px to a bare number and leaves the rest as it is", () => {
    expect(toCssLength("24")).toBe("24px")
    expect(toCssLength(" 8.5 ")).toBe("8.5px")
    expect(toCssLength("1rem")).toBe("1rem")
    expect(toCssLength("50%")).toBe("50%")
    expect(toCssLength("")).toBe("")
    expect(toCssLength("1.5", true)).toBe("1.5")
  })

  it("numberOf reads the number (with or without px) and rejects the rest", () => {
    expect(numberOf("16")).toBe(16)
    expect(numberOf("16px")).toBe(16)
    expect(numberOf("-2.5px")).toBe(-2.5)
    expect(numberOf("1rem")).toBeNull()
    expect(numberOf("auto")).toBeNull()
    expect(numberOf("")).toBeNull()
  })
})
