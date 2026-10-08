import { beforeEach, describe, expect, it, vi } from "vitest"

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
    expect(sendMessage.mock.calls[0][2].options.retries).toBe(3)
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

  it("editar um item grava no mesmo lugar da fila", () => {
    queue("primeira")
    const store = useMessageQueueStore.getState()
    store.enqueueForSend("s1", "segunda", {}, "code")
    store.enqueueForSend("s1", "terceira", {}, "code")
    // Depois dos enqueues: o snapshot do getState acima é velho.
    const antes = useMessageQueueStore.getState().queues.s1.map((m) => m.id)

    useMessageQueueStore.getState().update("s1", antes[1], "segunda (editada)")

    const depois = useMessageQueueStore.getState().queues.s1
    expect(depois.map((m) => m.id)).toEqual(antes)
    expect(depois.map((m) => m.text)).toEqual(["primeira", "segunda (editada)", "terceira"])
  })

  it("editar não perde os campos do item (modo, opções, sessão)", () => {
    queue("original")
    const q = useMessageQueueStore.getState()
    const antes = q.queues.s1[0]
    q.update("s1", antes.id, "editada")

    const depois = useMessageQueueStore.getState().queues.s1[0]
    expect(depois.text).toBe("editada")
    expect(depois.mode).toBe(antes.mode)
    expect(depois.sessionId).toBe(antes.sessionId)
    expect(depois.createdAt).toBe(antes.createdAt)
  })

  it("remover ou enviar o item em edição encerra o modo edição", () => {
    useMessageQueueStore.setState({ editing: {} })
    queue("alvo")
    const q = useMessageQueueStore.getState()
    const id = q.queues.s1[0].id
    q.startEdit("s1", id)
    expect(useMessageQueueStore.getState().editing.s1).toBe(id)

    useMessageQueueStore.getState().remove("s1", id)
    expect(useMessageQueueStore.getState().editing.s1).toBeUndefined()
  })

  it("enviar primeiro traz o item para a frente sem bagunçar o resto", () => {
    queue("primeira")
    const store = useMessageQueueStore.getState()
    store.enqueueForSend("s1", "segunda", {}, "code")
    store.enqueueForSend("s1", "terceira", {}, "code")
    const ultima = useMessageQueueStore.getState().queues.s1[2]

    useMessageQueueStore.getState().moveToFront("s1", ultima.id)

    expect(useMessageQueueStore.getState().queues.s1.map((m) => m.text)).toEqual([
      "terceira",
      "primeira",
      "segunda",
    ])
    // Quem já está na frente não muda de lugar — nem reordena à toa.
    useMessageQueueStore.getState().moveToFront("s1", ultima.id)
    expect(useMessageQueueStore.getState().queues.s1.map((m) => m.text)).toEqual([
      "terceira",
      "primeira",
      "segunda",
    ])
  })
})
