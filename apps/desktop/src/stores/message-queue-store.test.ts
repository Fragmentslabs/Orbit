import { beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_QUEUE_RETRIES } from "@shared/chat"

const status: Record<string, string> = {}
const sendMessage = vi.fn()

vi.mock("@/src/lib/ipc", () => ({ storage: { write: vi.fn(), read: vi.fn() } }))
vi.mock("@/src/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ status, sendMessage }) },
}))

const { useMessageQueueStore } = await import("./message-queue-store")

function queue(text: string) {
  useMessageQueueStore.setState({ queues: {} })
  status.s1 = "streaming"
  useMessageQueueStore.getState().enqueueForSend("s1", text, {}, "code")
}

describe("fila de mensagens", () => {
  beforeEach(() => {
    sendMessage.mockReset()
    for (const k of Object.keys(status)) delete status[k]
  })

  it("sai quando o turno anterior termina bem, já com as rodadas extras", () => {
    queue("próxima")
    status.s1 = "idle"
    useMessageQueueStore.getState().onSessionIdle("s1")

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toBe("próxima")
    expect(sendMessage.mock.calls[0][2].options.retries).toBe(MAX_QUEUE_RETRIES)
  })

  it("pausa quando o turno anterior falha — nem o agendador a solta", () => {
    queue("depende da resposta anterior")
    status.s1 = "error"
    const q = useMessageQueueStore.getState()
    q.onSessionIdle("s1")
    q.processQueue("s1")

    expect(sendMessage).not.toHaveBeenCalled()
    expect(q.queueSize("s1")).toBe(1)
  })

  it("um item da fila que falhou não é reenviado pela fila (o engine repete o turno)", () => {
    queue("falha")
    status.s1 = "idle"
    const q = useMessageQueueStore.getState()
    q.onSessionIdle("s1")
    status.s1 = "error"
    q.onSessionIdle("s1")

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(q.queueSize("s1")).toBe(0)
  })

  it("volta a andar depois de um turno que termina bem", () => {
    queue("segura")
    status.s1 = "error"
    const q = useMessageQueueStore.getState()
    q.onSessionIdle("s1")
    status.s1 = "idle"
    q.onSessionIdle("s1")

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it("sendNow tira o item da fila pausada e envia", () => {
    queue("manual")
    status.s1 = "error"
    const q = useMessageQueueStore.getState()
    const id = q.queues.s1[0].id
    q.sendNow("s1", id)

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(q.queueSize("s1")).toBe(0)
  })

  it("sendNow não atropela um turno em andamento", () => {
    queue("espera")
    const q = useMessageQueueStore.getState()
    q.sendNow("s1", q.queues.s1[0].id)

    expect(sendMessage).not.toHaveBeenCalled()
    expect(q.queueSize("s1")).toBe(1)
  })
})
