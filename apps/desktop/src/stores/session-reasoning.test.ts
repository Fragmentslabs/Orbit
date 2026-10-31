import { beforeEach, describe, expect, it, vi } from "vitest"

const stored: Record<string, string> = {}
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stored[k] ?? null,
  setItem: (k: string, v: string) => {
    stored[k] = v
  },
})

// The reasoning store reads the sessions to inherit the level of the last chat used —
// the same rule the per-chat model follows.
const sessions = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }))
vi.mock("@/src/stores/session-store", () => ({ useSessionStore: { getState: () => ({ sessions: sessions.list }) } }))

const { useSessionReasoning, sessionReasoningFor } = await import("./session-reasoning")
const { useReasoningPrefsStore } = await import("./reasoning-prefs")

beforeEach(() => {
  stored["orbit-session-reasoning"] = "{}"
  useSessionReasoning.setState({ overrides: {} })
  useReasoningPrefsStore.setState({ prefs: {} } as never)
  sessions.list = []
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

  it("adopt with no fallback still carries the draft (session created outside the send)", () => {
    useSessionReasoning.getState().setPref(null, { enabled: true, variantId: "high" })
    useSessionReasoning.getState().adopt("s_painel")
    expect(useSessionReasoning.getState().overrides.s_painel).toEqual({ enabled: true, variantId: "high" })
    expect(useSessionReasoning.getState().overrides.draft).toBeUndefined()
  })
})

describe("new chat inherits the last chat used", () => {
  it("with no choice in the draft, it opens with the thinking of the last chat", () => {
    useReasoningPrefsStore.setState({ prefs: { "anthropic/opus": { enabled: false } } } as never)
    sessions.list = [
      { id: "s_antiga", archived: false, updatedAt: 1 },
      { id: "s_recente", archived: false, updatedAt: 5 },
    ]
    useSessionReasoning.getState().setPref("s_recente", { enabled: true, variantId: "high" })
    expect(sessionReasoningFor(null, "anthropic", "opus")).toEqual({ enabled: true, variantId: "high" })
  })

  it("a choice made in the draft wins over the last chat's", () => {
    sessions.list = [{ id: "s_recente", archived: false, updatedAt: 5 }]
    useSessionReasoning.getState().setPref("s_recente", { enabled: true, variantId: "low" })
    useSessionReasoning.getState().setPref(null, { enabled: true, variantId: "max" })
    expect(sessionReasoningFor(null, "anthropic", "opus")).toEqual({ enabled: true, variantId: "max" })
  })

  it("the last chat of the sidebar ignores archived chats and workers", () => {
    sessions.list = [
      { id: "s_arquivada", archived: true, updatedAt: 9 },
      { id: "s_worker", archived: false, updatedAt: 8, parentId: "s_arquivada" },
      { id: "s_viva", archived: false, updatedAt: 3 },
    ]
    useSessionReasoning.getState().setPref("s_arquivada", { enabled: true, variantId: "max" })
    useSessionReasoning.getState().setPref("s_worker", { enabled: true, variantId: "max" })
    useSessionReasoning.getState().setPref("s_viva", { enabled: true, variantId: "low" })
    expect(sessionReasoningFor(null, "anthropic", "opus")).toEqual({ enabled: true, variantId: "low" })
  })

  it("with no chat to inherit from, the model's level applies", () => {
    useReasoningPrefsStore.setState({ prefs: { "anthropic/opus": { enabled: true, variantId: "medium" } } } as never)
    expect(sessionReasoningFor(null, "anthropic", "opus")).toEqual({ enabled: true, variantId: "medium" })
  })
})
