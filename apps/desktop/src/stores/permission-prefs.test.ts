import { beforeEach, describe, expect, it, vi } from "vitest"

const respostas = vi.hoisted(() => [] as Array<[string, unknown]>)
const sessoes = vi.hoisted(() => ({
  activeIds: { chat: null as string | null, code: "s_tela" as string | null },
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

const { usePermissionPrefs } = await import("./permission-prefs")

beforeEach(() => {
  respostas.length = 0
  armazenado["orbit-default-mode"] = JSON.stringify("code")
  usePermissionPrefs.setState({ mode: "ask" })
  sessoes.pendingAsks = {
    s_tela: [
      { requestId: "p1", kind: "permission", claim: { tool: "bash", title: "x" } },
      { requestId: "p2", kind: "permission", claim: { tool: "worktree_remove", title: "y", alwaysAsk: true } },
      { requestId: "q1", kind: "question", questions: [] },
    ],
    s_outro: [{ requestId: "p3", kind: "permission", claim: { tool: "bash", title: "z" } }],
  }
})

describe("mudar o modo de permissão pela tela", () => {
  it("para Irrestrito aprova os pedidos de permissão abertos do chat da tela", () => {
    usePermissionPrefs.getState().setMode("full")
    expect(respostas).toEqual([["p1", "allow"]])
  })

  it("para Ask ou Aprovar não responde nada", () => {
    usePermissionPrefs.getState().setMode("approve")
    expect(respostas).toEqual([])
  })

  it("troca vinda do celular só muda o modo", () => {
    usePermissionPrefs.getState().applyRemoteMode("full")
    expect(usePermissionPrefs.getState().mode).toBe("full")
    expect(respostas).toEqual([])
  })
})
