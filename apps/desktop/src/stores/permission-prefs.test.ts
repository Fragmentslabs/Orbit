import { beforeEach, describe, expect, it, vi } from "vitest"

const respostas = vi.hoisted(() => [] as Array<[string, unknown]>)
const sessoes = vi.hoisted(() => ({
  pendingAsks: {} as Record<string, Array<Record<string, unknown>>>,
}))
vi.mock("@/src/lib/ipc", () => ({
  chatApi: { askReply: (id: string, valor: unknown) => respostas.push([id, valor]) },
}))
vi.mock("@/src/stores/session-store", () => ({ useSessionStore: { getState: () => sessoes } }))

const armazenado: Record<string, string> = {}
vi.stubGlobal("localStorage", {
  getItem: (k: string) => armazenado[k] ?? null,
  setItem: (k: string, v: string) => {
    armazenado[k] = v
  },
})

const { usePermissionPrefs, permissionFor } = await import("./permission-prefs")

beforeEach(() => {
  respostas.length = 0
  armazenado["orbit-permission-mode"] = "ask"
  armazenado["orbit-session-permission"] = "{}"
  usePermissionPrefs.setState({ defaultMode: "ask", modes: {} })
  sessoes.pendingAsks = {
    s_tela: [
      { requestId: "p1", kind: "permission", claim: { tool: "bash", title: "x" } },
      { requestId: "p2", kind: "permission", claim: { tool: "worktree_remove", title: "y", alwaysAsk: true } },
      { requestId: "q1", kind: "question", questions: [] },
    ],
    s_outro: [{ requestId: "p3", kind: "permission", claim: { tool: "bash", title: "z" } }],
  }
})

describe("autonomia por chat", () => {
  it("mudar num chat NÃO muda o outro nem o padrão", () => {
    usePermissionPrefs.getState().setMode("s_a", "full")
    expect(permissionFor("s_a")).toBe("full")
    expect(permissionFor("s_b")).toBe("ask")
    expect(usePermissionPrefs.getState().defaultMode).toBe("ask")
  })

  it("chat novo (draft) vira o padrão do próximo chat novo", () => {
    usePermissionPrefs.getState().setMode(null, "approve")
    expect(permissionFor(null)).toBe("approve")
    expect(usePermissionPrefs.getState().defaultMode).toBe("approve")
  })

  it("o adopt leva a escolha do rascunho para a sessão criada", () => {
    usePermissionPrefs.getState().setMode(null, "full")
    usePermissionPrefs.getState().adopt("s_nova")
    expect(permissionFor("s_nova")).toBe("full")
    // O rascunho some: o próximo chat novo já nasce no padrão (que a escolha
    // no chat novo atualizou, como acontece com o modelo).
    expect(usePermissionPrefs.getState().modes.draft).toBeUndefined()
    expect(permissionFor(null)).toBe("full")
  })
})

describe("mudar o nível pela tela", () => {
  it("para Irrestrito aprova os pedidos de permissão abertos DAQUELE chat", () => {
    usePermissionPrefs.getState().setMode("s_tela", "full")
    expect(respostas).toEqual([["p1", "allow"]])
  })

  it("para Ask ou Aprovar não responde nada", () => {
    usePermissionPrefs.getState().setMode("s_tela", "approve")
    expect(respostas).toEqual([])
  })

  it("troca vinda do celular só muda o nível do chat, sem liberar pedidos", () => {
    usePermissionPrefs.getState().applyRemoteMode("s_outro", "full")
    expect(permissionFor("s_outro")).toBe("full")
    expect(permissionFor("s_tela")).toBe("ask")
    expect(respostas).toEqual([])
  })
})
