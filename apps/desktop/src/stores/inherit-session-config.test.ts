import { beforeEach, describe, expect, it, vi } from "vitest"

const stored: Record<string, string> = {}
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stored[k] ?? null,
  setItem: (k: string, v: string) => {
    stored[k] = v
  },
})

const sessions = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }))
vi.mock("@/src/stores/session-store", () => ({ useSessionStore: { getState: () => ({ sessions: sessions.list }) } }))
vi.mock("@/src/lib/ipc", () => ({ sessionModelsApi: { sync: () => {}, onSelect: () => {} } }))
vi.mock("@/src/stores/provider-store", () => ({
  useProviderStore: Object.assign(() => null, {
    getState: () => ({ selectedModel: { providerId: "default-provider", modelId: "default-model" }, selectModel: () => {} }),
  }),
}))
vi.mock("@/src/stores/model-rotation-store", () => ({ useModelRotationStore: { getState: () => ({}) } }))

const { captureSessionConfig, inheritSessionConfig } = await import("./inherit-session-config")
const { useSessionModelPrefs, sessionModelFor } = await import("./session-model-prefs")
const { useSessionReasoning, sessionReasoningFor } = await import("./session-reasoning")
const { usePermissionPrefs, permissionFor } = await import("./permission-prefs")

beforeEach(() => {
  useSessionModelPrefs.setState({ overrides: {}, recents: [] })
  useSessionReasoning.setState({ overrides: {} })
  usePermissionPrefs.setState({ modes: {} } as never)
  sessions.list = []
})

describe("inheritSessionConfig (/init and forks)", () => {
  it("the new session keeps the model the origin chat had selected, not the global default", () => {
    useSessionModelPrefs.getState().selectModel("s_origem", "deepseek", "v4-pro")
    // Without it: the new session fell into the global default.
    expect(sessionModelFor("s_init")).toEqual({ providerId: "default-provider", modelId: "default-model" })
    inheritSessionConfig("s_origem", "s_init")
    expect(sessionModelFor("s_init")).toEqual({ providerId: "deepseek", modelId: "v4-pro" })
  })

  it("carries thinking and permission too", () => {
    useSessionModelPrefs.getState().selectModel("s_origem", "anthropic", "opus")
    useSessionReasoning.getState().setPref("s_origem", { enabled: true, variantId: "high" })
    usePermissionPrefs.getState().applyRemoteMode("s_origem", "full")
    inheritSessionConfig("s_origem", "s_init")
    expect(sessionReasoningFor("s_init", "anthropic", "opus")).toEqual({ enabled: true, variantId: "high" })
    expect(permissionFor("s_init")).toBe("full")
  })

  it("from the draft (no session yet) it takes what the input shows", () => {
    useSessionModelPrefs.getState().selectModel(undefined, "openai", "gpt-x")
    inheritSessionConfig(undefined, "s_init")
    expect(sessionModelFor("s_init")).toEqual({ providerId: "openai", modelId: "gpt-x" })
  })

  it("choosing in the new session afterwards does not touch the origin", () => {
    useSessionModelPrefs.getState().selectModel("s_origem", "deepseek", "v4-pro")
    inheritSessionConfig("s_origem", "s_init")
    useSessionModelPrefs.getState().selectModel("s_init", "anthropic", "opus")
    expect(sessionModelFor("s_origem")).toEqual({ providerId: "deepseek", modelId: "v4-pro" })
  })

  it("a draft that follows the last chat keeps that model when /init opens its chat (captured before the session exists)", () => {
    // The last chat used Y; the new chat of a new project has no choice of its own and SHOWS Y.
    sessions.list = [{ id: "s_ultimo", updatedAt: 10 }]
    useSessionModelPrefs.getState().selectModel("s_ultimo", "deepseek", "v4-pro")
    useSessionReasoning.getState().setPref("s_ultimo", { enabled: true, variantId: "high" })
    expect(sessionModelFor(undefined)).toEqual({ providerId: "deepseek", modelId: "v4-pro" })

    const inherit = captureSessionConfig(undefined)
    // Creating the session makes IT the most recent chat, with no choice of its own.
    sessions.list = [{ id: "s_init", updatedAt: 20 }, { id: "s_ultimo", updatedAt: 10 }]
    inherit("s_init")
    expect(sessionModelFor("s_init")).toEqual({ providerId: "deepseek", modelId: "v4-pro" })
    expect(sessionReasoningFor("s_init", "deepseek", "v4-pro")).toEqual({ enabled: true, variantId: "high" })
  })

  it("reading AFTER the session exists is what used to give the global default", () => {
    sessions.list = [{ id: "s_ultimo", updatedAt: 10 }]
    useSessionModelPrefs.getState().selectModel("s_ultimo", "deepseek", "v4-pro")
    sessions.list = [{ id: "s_init", updatedAt: 20 }, { id: "s_ultimo", updatedAt: 10 }]
    inheritSessionConfig(undefined, "s_init")
    expect(sessionModelFor("s_init")).toEqual({ providerId: "default-provider", modelId: "default-model" })
  })
})
