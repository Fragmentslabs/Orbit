import { describe, expect, it } from "vitest"
import type { ToolPart } from "@shared/chat"
import { fragmentRefOf } from "./fragment-part-ref"

const part = (extra: Partial<ToolPart>): ToolPart => ({ id: "p", type: "tool", tool: "fragment_create", state: "completed", ...extra }) as ToolPart

describe("fragmentRefOf", () => {
  it("reads the id of a creation from its result, and the name from its input", () => {
    const ref = fragmentRefOf(part({ input: { name: "Habits" }, output: JSON.stringify({ fragmentId: "frag-habits-1", message: "ok" }) }))
    expect(ref).toEqual({ id: "frag-habits-1", name: "Habits" })
  })

  it("reads the id of an edit from its arguments", () => {
    expect(fragmentRefOf(part({ tool: "fragment_edit_file", input: { fragmentId: "frag-a-2", path: "a.css" }, output: "Edited a.css" }))).toEqual({
      id: "frag-a-2",
      name: undefined,
    })
  })

  it("gives no card when there is no id (a failed creation, a plain-text result)", () => {
    expect(fragmentRefOf(part({ output: "Could not create the fragment: boom" }))).toBeNull()
    expect(fragmentRefOf(part({}))).toBeNull()
  })
})
