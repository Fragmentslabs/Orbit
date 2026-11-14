import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setActivePeer } from "./env-source"

/**
 * Routines, the pipeline and Usage are one set of screens; with another desktop picked
 * in the environment selector their data layer must ask THAT machine — and only then.
 */

const PEER = "a".repeat(32)
const invoke = vi.fn()

beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal("window", { ipcRenderer: { invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() } })
})

afterEach(() => {
  setActivePeer(null)
  vi.unstubAllGlobals()
})

async function api() {
  return import("./ipc")
}

describe("another desktop as the data source", () => {
  it("reads this machine's routines through IPC when no peer is selected", async () => {
    invoke.mockResolvedValue({ routines: [], runs: [], activities: [] })
    const { routinesApi } = await api()
    await routinesApi.load()
    expect(invoke).toHaveBeenCalledWith("routines:load")
  })

  it("reads the peer's routines and namespaces the run sessions like every remote chat", async () => {
    setActivePeer(PEER)
    invoke.mockResolvedValue({
      routines: [{ id: "r1" }],
      runs: [{ routineId: "r1", sessionId: "routine_r1_1", startedAt: 1, status: "ok", tokens: 0, cost: 0 }],
      activities: [],
    })
    const { routinesApi } = await api()
    const data = await routinesApi.load()
    expect(invoke).toHaveBeenCalledWith("peers:request", PEER, { type: "routines:list" })
    expect(data.runs[0].sessionId).toBe(`peer:${PEER}:routine_r1_1`)
  })

  it("asks the peer for usage with the same range and mode", async () => {
    setActivePeer(PEER)
    invoke.mockResolvedValue({})
    const { analyticsApi } = await api()
    await analyticsApi.summary("7d", "code")
    expect(invoke).toHaveBeenCalledWith("peers:request", PEER, { type: "analytics:summary", range: "7d", mode: "code" })
  })

  it("loads the pipeline snapshot and its templates from the peer", async () => {
    setActivePeer(PEER)
    invoke.mockResolvedValue({ projects: [], pipelines: [], tasksPerPipeline: {}, templates: [{ id: "t" }] })
    const { pipelineApi } = await api()
    const data = await pipelineApi.load()
    const templates = await pipelineApi.templates()
    expect(data.pipelines).toEqual([])
    expect(templates).toEqual([{ id: "t" }])
    expect(invoke).toHaveBeenCalledWith("peers:request", PEER, { type: "pipeline:list" })
  })

  it("reads and edits the peer's memories, with the document fetched on demand", async () => {
    setActivePeer(PEER)
    invoke.mockImplementation(async (_channel: string, _peer: string, payload: { type: string }) => {
      if (payload.type === "memory:list") return [{ id: "m1", text: "a" }]
      if (payload.type === "memory:doc") return "# doc"
      return null
    })
    const { memoryApi } = await api()
    expect(await memoryApi.list()).toEqual([{ id: "m1", text: "a" }])
    expect(await memoryApi.get("m1")).toEqual({ memory: { id: "m1", text: "a" }, document: "# doc" })
    await memoryApi.update("m1", { text: "b" })
    expect(invoke).toHaveBeenCalledWith("peers:request", PEER, { type: "memory:update", id: "m1", patch: { text: "b" } })
  })

  it("never runs local-only actions on the wrong machine", async () => {
    setActivePeer(PEER)
    const { pipelineApi, routinesApi } = await api()
    await expect(pipelineApi.report("p")).rejects.toThrow("remote_unsupported")
    await expect(routinesApi.approveScript("r", "s")).rejects.toThrow("remote_unsupported")
    expect(await routinesApi.pending()).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })
})
