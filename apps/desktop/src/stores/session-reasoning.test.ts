import { beforeEach, describe, expect, it, vi } from "vitest"

const armazenado: Record<string, string> = {}
vi.stubGlobal("localStorage", {
  getItem: (k: string) => armazenado[k] ?? null,
  setItem: (k: string, v: string) => {
    armazenado[k] = v
  },
})

const { useSessionReasoning, sessionReasoningFor } = await import("./session-reasoning")
const { useReasoningPrefsStore } = await import("./reasoning-prefs")

beforeEach(() => {
  armazenado["orbit-session-reasoning"] = "{}"
  useSessionReasoning.setState({ overrides: {} })
  useReasoningPrefsStore.setState({ prefs: {} } as never)
})

describe("thinking por chat", () => {
  it("mudar num chat NÃO muda o outro", () => {
    useSessionReasoning.getState().setPref("s_a", { enabled: true, variantId: "high" })
    expect(sessionReasoningFor("s_a", "anthropic", "opus")).toEqual({ enabled: true, variantId: "high" })
    expect(sessionReasoningFor("s_b", "anthropic", "opus")).toBeUndefined()
  })

  it("sem escolha no chat, vale o nível do modelo (Preferências)", () => {
    useReasoningPrefsStore.setState({ prefs: { "anthropic/opus": { enabled: true, variantId: "low" } } } as never)
    expect(sessionReasoningFor("s_sem_escolha", "anthropic", "opus")).toEqual({ enabled: true, variantId: "low" })
  })

  it("depois que o chat escolhe, mexer no default do modelo não o move", () => {
    useSessionReasoning.getState().setPref("s_a", { enabled: false })
    useReasoningPrefsStore.setState({ prefs: { "anthropic/opus": { enabled: true, variantId: "max" } } } as never)
    expect(sessionReasoningFor("s_a", "anthropic", "opus")).toEqual({ enabled: false })
  })

  it("o adopt leva a escolha do rascunho para a sessão criada", () => {
    useSessionReasoning.getState().setPref(null, { enabled: true, variantId: "medium" })
    useSessionReasoning.getState().adopt("s_nova", { enabled: false })
    expect(useSessionReasoning.getState().overrides.s_nova).toEqual({ enabled: true, variantId: "medium" })
    expect(useSessionReasoning.getState().overrides.draft).toBeUndefined()
  })

  it("adopt sem escolha no rascunho fixa o nível em vigor", () => {
    useSessionReasoning.getState().adopt("s_nova", { enabled: true, variantId: "high" })
    expect(useSessionReasoning.getState().overrides.s_nova).toEqual({ enabled: true, variantId: "high" })
  })
})
