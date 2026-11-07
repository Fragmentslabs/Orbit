import { describe, expect, it } from "vitest"
import { summarizeActivity } from "./artifact-activity"

describe("summarizeActivity", () => {
  it("is quiet when no chat is working and nothing is unread", () => {
    expect(summarizeActivity(["a", "b"], { a: "idle" }, {})).toEqual({ working: false, unread: false })
  })

  it("shows work while any chat of the artifact is submitted or streaming", () => {
    expect(summarizeActivity(["a", "b"], { b: "streaming" }, {}).working).toBe(true)
    expect(summarizeActivity(["a"], { a: "submitted" }, {}).working).toBe(true)
  })

  it("shows the done bullet when a chat finished with something unread", () => {
    expect(summarizeActivity(["a"], { a: "idle" }, { a: 2 })).toEqual({ working: false, unread: true })
  })

  it("lets the spinner win over the bullet while another chat still works", () => {
    expect(summarizeActivity(["a", "b"], { a: "idle", b: "streaming" }, { a: 1 })).toEqual({ working: true, unread: false })
  })

  it("ignores chats that are not the artifact's", () => {
    expect(summarizeActivity(["a"], { z: "streaming" }, { z: 3 })).toEqual({ working: false, unread: false })
  })
})
