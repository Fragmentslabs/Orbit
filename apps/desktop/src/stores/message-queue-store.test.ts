import { beforeEach, describe, expect, it, vi } from "vitest"

const status: Record<string, string> = {}
const sendMessage = vi.fn()
/** Sessions main says are running (chat:running). */
let running: string[] = []

const storageWrite = vi.fn()
const storageRead = vi.fn()

vi.mock("@/src/lib/ipc", () => ({
  storage: { write: (...args: unknown[]) => storageWrite(...args), read: (...args: unknown[]) => storageRead(...args) },
  chatApi: { running: () => Promise.resolve(running) },
}))
vi.mock("@/src/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ status, sendMessage }) },
}))

const { useMessageQueueStore } = await import("./message-queue-store")

/** The queue exit checks main before sending (asynchronous). */
const settle = () => new Promise((r) => setTimeout(r, 0))

function queue(text: string) {
  useMessageQueueStore.setState({ queues: {} })
  status.s1 = "streaming"
  useMessageQueueStore.getState().enqueueForSend("s1", text, {}, "code")
}

describe("message queue", () => {
  beforeEach(() => {
    sendMessage.mockReset()
    running = []
    for (const k of Object.keys(status)) delete status[k]
  })

  it("goes out when the previous turn ends well, extra rounds included", async () => {
    queue("próxima")
    status.s1 = "idle"
    useMessageQueueStore.getState().onSessionIdle("s1")
    await settle()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toBe("próxima")
    expect(sendMessage.mock.calls[0][2].options.retries).toBe(3)
  })

  it("pauses when the previous turn fails — not even the scheduler releases it", async () => {
    queue("depende da resposta anterior")
    status.s1 = "error"
    const q = useMessageQueueStore.getState()
    q.onSessionIdle("s1")
    q.processQueue("s1")
    await settle()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(q.queueSize("s1")).toBe(1)
  })

  it("a queue item that failed is not resent by the queue (the engine repeats the turn)", async () => {
    queue("falha")
    status.s1 = "idle"
    const q = useMessageQueueStore.getState()
    q.onSessionIdle("s1")
    await settle()
    status.s1 = "error"
    q.onSessionIdle("s1")
    await settle()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(q.queueSize("s1")).toBe(0)
  })

  it("moves again after a turn that ends well", async () => {
    queue("segura")
    status.s1 = "error"
    const q = useMessageQueueStore.getState()
    q.onSessionIdle("s1")
    status.s1 = "idle"
    q.onSessionIdle("s1")
    await settle()

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it("does not go out while main still runs the session (idle between loop iterations)", async () => {
    vi.useFakeTimers()
    try {
      queue("after do loop")
      status.s1 = "idle"
      running = ["s1"]
      useMessageQueueStore.getState().onSessionIdle("s1")
      await vi.advanceTimersByTimeAsync(0)
      expect(sendMessage).not.toHaveBeenCalled()

      // The loop is over: the re-check releases the queue without needing another idle.
      running = []
      await vi.advanceTimersByTimeAsync(2_500)
      expect(sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("the whole queue goes to disk, not only the scheduled ones", () => {
    storageWrite.mockReset()
    queue("assim que possível")
    const [, saved] = storageWrite.mock.calls.at(-1)!
    expect(saved.s1.map((m: { text: string }) => m.text)).toEqual(["assim que possível"])
  })

  it("on open, it merges what was saved with what arrived during the read", async () => {
    useMessageQueueStore.setState({ queues: {} })
    useMessageQueueStore.getState().enqueueForSend("s1", "chegou agora", {}, "code")
    storageRead.mockResolvedValueOnce({
      s1: [{ id: "q_salvo", text: "de before", options: {}, mode: "code", sessionId: "s1", createdAt: 1 }],
    })
    await useMessageQueueStore.getState().initialize()

    expect(useMessageQueueStore.getState().queues.s1.map((m) => m.text)).toEqual(["de before", "chegou agora"])
  })

  it("sendNow takes the item out of the paused queue and sends it", () => {
    queue("manual")
    status.s1 = "error"
    const q = useMessageQueueStore.getState()
    const id = q.queues.s1[0].id
    q.sendNow("s1", id)

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(q.queueSize("s1")).toBe(0)
  })

  it("sendNow does not cut into a turn in progress", () => {
    queue("espera")
    const q = useMessageQueueStore.getState()
    q.sendNow("s1", q.queues.s1[0].id)

    expect(sendMessage).not.toHaveBeenCalled()
    expect(q.queueSize("s1")).toBe(1)
  })

  it("editing an item writes to the same place in the queue", () => {
    queue("primeira")
    const store = useMessageQueueStore.getState()
    store.enqueueForSend("s1", "segunda", {}, "code")
    store.enqueueForSend("s1", "terceira", {}, "code")
    // After the enqueues: the getState snapshot above is stale.
    const before = useMessageQueueStore.getState().queues.s1.map((m) => m.id)

    useMessageQueueStore.getState().update("s1", before[1], "segunda (editada)")

    const after = useMessageQueueStore.getState().queues.s1
    expect(after.map((m) => m.id)).toEqual(before)
    expect(after.map((m) => m.text)).toEqual(["primeira", "segunda (editada)", "terceira"])
  })

  it("editing does not lose the item's fields (mode, options, session)", () => {
    queue("original")
    const q = useMessageQueueStore.getState()
    const before = q.queues.s1[0]
    q.update("s1", before.id, "editada")

    const after = useMessageQueueStore.getState().queues.s1[0]
    expect(after.text).toBe("editada")
    expect(after.mode).toBe(before.mode)
    expect(after.sessionId).toBe(before.sessionId)
    expect(after.createdAt).toBe(before.createdAt)
  })

  it("removing or sending the item being edited ends edit mode", () => {
    useMessageQueueStore.setState({ editing: {} })
    queue("alvo")
    const q = useMessageQueueStore.getState()
    const id = q.queues.s1[0].id
    q.startEdit("s1", id)
    expect(useMessageQueueStore.getState().editing.s1).toBe(id)

    useMessageQueueStore.getState().remove("s1", id)
    expect(useMessageQueueStore.getState().editing.s1).toBeUndefined()
  })

  it("send first brings the item forward without messing up the rest", () => {
    queue("primeira")
    const store = useMessageQueueStore.getState()
    store.enqueueForSend("s1", "segunda", {}, "code")
    store.enqueueForSend("s1", "terceira", {}, "code")
    const last = useMessageQueueStore.getState().queues.s1[2]

    useMessageQueueStore.getState().moveToFront("s1", last.id)

    expect(useMessageQueueStore.getState().queues.s1.map((m) => m.text)).toEqual([
      "terceira",
      "primeira",
      "segunda",
    ])
    // Whoever is already in front does not change places — nor reorders for nothing.
    useMessageQueueStore.getState().moveToFront("s1", last.id)
    expect(useMessageQueueStore.getState().queues.s1.map((m) => m.text)).toEqual([
      "terceira",
      "primeira",
      "segunda",
    ])
  })
})
