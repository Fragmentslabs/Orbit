import { describe, expect, it } from "vitest"
import { folderLabel } from "./folder-label"

describe("folderLabel", () => {
  it("takes the last segment, whatever separator the other machine uses", () => {
    expect(folderLabel("/Users/a/Projects/Orbit")).toBe("Orbit")
    expect(folderLabel("C:\\work\\api\\")).toBe("api")
    expect(folderLabel("/")).toBe("/")
  })
})
