import { beforeEach, describe, expect, it, vi } from "vitest"

const stored: Record<string, string> = {}
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stored[k] ?? null,
  setItem: (k: string, v: string) => {
    stored[k] = v
  },
})

const { useSessionReasoning, sessionReasoningFor } = await import("./session-reasoning")
const { useReasoningPrefsStore } = await import("./reasoning-prefs")

beforeEach(() => {
  stored["orbit-session-reasoning"] = "{}"
  useSessionReasoning.setState({ overrides: {} })
  useReasoningPrefsStore.setState({ prefs: {} } as never)
})

describe("thinking per chat", () => {
  it("changing it in one chat does NOT change the other", () => {
    useSessionReasoning.getState().setPref("s_a", { enabled: true, variantId: "high" })
    expect(sessionReasoningFor("s_a", "anthropic", "opus")).toEqual({ enabled: true, variantId: "high" })
    expect(sessionReasoningFor("s_b", "anthropic", "opus")).toBeUndefined()
  })

  it("with no choice in the chat, the model's level applies (Preferences)", () => {
    useReasoningPrefsStore.setState({ prefs: { "anthropic/opus": { enabled: true, variantId: "low" } } } as never)
    expect(sessionReasoningFor("s_sem_escolha", "anthropic", "opus")).toEqual({ enabled: true, variantId: "low" })
  })

  it("once the chat chooses, changing the model default does not move it", () => {
    useSessionReasoning.getState().setPref("s_a", { enabled: false })
    useReasoningPrefsStore.setState({ prefs: { "anthropic/opus": { enabled: true, variantId: "max" } } } as never)
    expect(sessionReasoningFor("s_a", "anthropic", "opus")).toEqual({ enabled: false })
  })

  it("adopt carries the draft's choice to the created session", () => {
    useSessionReasoning.getState().setPref(null, { enabled: true, variantId: "medium" })
    useSessionReasoning.getState().adopt("s_nova", { enabled: false })
    expect(useSessionReasoning.getState().overrides.s_nova).toEqual({ enabled: true, variantId: "medium" })
    expect(useSessionReasoning.getState().overrides.draft).toBeUndefined()
  })

  it("adopt with no draft choice pins the level in force", () => {
    useSessionReasoning.getState().adopt("s_nova", { enabled: true, variantId: "high" })
    expect(useSessionReasoning.getState().overrides.s_nova).toEqual({ enabled: true, variantId: "high" })
  })
})
