import { describe, expect, it } from "vitest"
import type { ChatMessage, MessagePart } from "@shared/chat"
import { workerActivity } from "./worker-activity"

function assistant(parts: MessagePart[], over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m", role: "assistant", parts, createdAt: 1, ...over }
}

describe("workerActivity", () => {
  it("is idle and empty with no messages", () => {
    expect(workerActivity(undefined)).toEqual({ kind: "idle", text: "" })
    expect(workerActivity([])).toEqual({ kind: "idle", text: "" })
  })

  it("shows the tool in use with the most telling input", () => {
    const parts: MessagePart[] = [{ id: "t", type: "tool", tool: "image_search", state: "running", input: { query: "Saturn rings", limit: 4 } }]
    expect(workerActivity([assistant(parts)])).toEqual({ kind: "tool", text: "image_search · Saturn rings" })
  })

  it("prefers the title of a tool over its name", () => {
    const parts: MessagePart[] = [{ id: "t", type: "tool", tool: "bash", state: "running", title: "Run tests" }]
    expect(workerActivity([assistant(parts)]).text).toBe("Run tests")
  })

  it("shows a thought in progress, keeping its end", () => {
    const parts: MessagePart[] = [{ id: "r", type: "reasoning", state: "streaming", text: `${"x".repeat(300)} the orbits` }]
    const activity = workerActivity([assistant(parts)])
    expect(activity.kind).toBe("thinking")
    expect(activity.text.endsWith("the orbits")).toBe(true)
    expect(activity.text.startsWith("…")).toBe(true)
  })

  it("shows the stretch of the answer being written", () => {
    const parts: MessagePart[] = [{ id: "x", type: "text", state: "streaming", text: "Scene 3:\n the Sun appears" }]
    expect(workerActivity([assistant(parts)])).toEqual({ kind: "writing", text: "Scene 3: the Sun appears" })
  })

  it("the latest live part wins over an earlier finished one", () => {
    const parts: MessagePart[] = [
      { id: "r", type: "reasoning", state: "done", text: "planned" },
      { id: "t", type: "tool", tool: "write", state: "running", input: { path: "a.md" } },
    ]
    expect(workerActivity([assistant(parts)]).kind).toBe("tool")
  })

  it("a finished message is a result: idle, carrying what it last said", () => {
    const parts: MessagePart[] = [{ id: "x", type: "text", state: "done", text: "3 screens delivered" }]
    expect(workerActivity([assistant(parts, { completedAt: 5 })])).toEqual({ kind: "idle", text: "3 screens delivered" })
  })

  it("ignores internal bookkeeping text as a result", () => {
    const parts: MessagePart[] = [
      { id: "a", type: "text", state: "done", text: "Real result" },
      { id: "b", type: "text", state: "done", text: "checking", source: "nudge" },
    ]
    expect(workerActivity([assistant(parts, { completedAt: 5 })]).text).toBe("Real result")
  })
})
