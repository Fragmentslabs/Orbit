import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage } from "@shared/chat"

const api = vi.hoisted(() => {
  const state = { handler: null as null | ((event: unknown) => void), pages: [] as ChatMessage[][] }
  return {
    state,
    peersApi: {
      onEvent: (h: (event: unknown) => void) => {
        state.handler = h
      },
      snapshot: async () => null,
      resend: async () => {},
      messages: vi.fn(async () => state.pages.shift() ?? []),
      sessionState: async () => ({
        planReview: { status: "proposed", messageId: "m1" },
        plan: { id: "p1", tasks: [], status: "proposed" },
        pendingAsks: [],
      }),
    },
  }
})
vi.mock("@/src/lib/ipc", () => ({ peersApi: api.peersApi }))
vi.stubGlobal("window", { ipcRenderer: {} })

const { usePeersStore, startPeersMirror } = await import("./peers-store")

const SID = "peer:a:s1"
const msg = (id: string): ChatMessage => ({ id, role: "user", parts: [], createdAt: 1 }) as unknown as ChatMessage
const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => msg(`m${from + i}`))
const emit = (event: Record<string, unknown>) => api.state.handler?.({ type: "chat", event: { sessionId: SID, ...event } })

describe("peers-store remote chat state", () => {
  beforeEach(() => {
    usePeersStore.setState({ messages: {}, historyExhausted: {}, olderLoading: {}, loading: {} })
    startPeersMirror()
  })

  it("reads the plan cards together with the first page", async () => {
    api.state.pages = [page(0, 3)]
    await usePeersStore.getState().loadMessages(SID, true)
    const s = usePeersStore.getState()
    expect(s.planReviews[SID]?.status).toBe("proposed")
    expect(s.orchestration[SID]?.id).toBe("p1")
    expect(s.historyExhausted[SID]).toBe(true)
  })

  it("pages older history beyond the first 100 and stops on a short page", async () => {
    api.state.pages = [page(100, 100), page(0, 40)]
    await usePeersStore.getState().loadMessages(SID, true)
    expect(usePeersStore.getState().historyExhausted[SID]).toBe(false)
    await usePeersStore.getState().loadOlder(SID)
    expect(api.peersApi.messages).toHaveBeenLastCalledWith(SID, { limit: 100, offset: 100 })
    const s = usePeersStore.getState()
    expect(s.messages[SID]).toHaveLength(140)
    expect(s.messages[SID][0].id).toBe("m0")
    expect(s.historyExhausted[SID]).toBe(true)
  })

  it("keeps the live events the composer and cards read", () => {
    emit({ type: "context", messageId: "m1", input: 10, output: 2, estimated: true })
    emit({ type: "suggestion", text: "and then?" })
    emit({ type: "compaction:suggest", summaries: 2 })
    emit({ type: "plan:review", review: { status: "implementing", messageId: "m1" } })
    emit({ type: "orchestration:plan", plan: { id: "p2", tasks: [], status: "running" } })
    emit({ type: "status", status: "fallback", fallback: { current: 1, total: 3 } })
    const s = usePeersStore.getState()
    expect(s.liveContext[SID]).toMatchObject({ input: 10, output: 2, estimated: true })
    expect(s.suggestions[SID]).toBe("and then?")
    expect(s.compactionSuggestion[SID]).toEqual({ summaries: 2, dismissed: false })
    expect(s.planReviews[SID]?.status).toBe("implementing")
    expect(s.orchestration[SID]?.id).toBe("p2")
    expect(s.fallback[SID]).toMatchObject({ current: 1, total: 3 })
    emit({ type: "status", status: "idle" })
    expect(usePeersStore.getState().fallback[SID]).toBeUndefined()
  })
})
