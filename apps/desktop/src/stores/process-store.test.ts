import { beforeEach, describe, expect, it, vi } from "vitest"

const list = vi.fn()
const kill = vi.fn()

vi.mock("@/src/lib/ipc", () => ({ processApi: { list, kill } }))

const { useProcessStore } = await import("./process-store")

import type { ProcessInfo } from "@/src/lib/ipc"

function processo(pid: number, sessionId?: string): ProcessInfo {
  return {
    pid,
    label: `proc-${pid}`,
    command: "npm run dev",
    cwd: "/tmp",
    startTime: 1_700_000_000_000,
    status: "running",
    sessionId,
  }
}

describe("processos da conversa", () => {
  beforeEach(() => {
    list.mockReset()
    kill.mockReset()
    useProcessStore.setState({ processes: [] })
  })

  // O rodapé do painel (e a tela inicial do browser) mostram os processos do
  // CHAT ABERTO. Um chat novo ainda não tem sessão — e pedir a lista sem filtro
  // devolvia a de todos os chats, que é como o dev server de um chat de código
  // acabou aparecendo dentro de um chat comum.
  it("sem sessão não vai ao main — a lista fica vazia", async () => {
    await useProcessStore.getState().fetch()

    expect(list).not.toHaveBeenCalled()
    expect(useProcessStore.getState().processes).toEqual([])
  })

  it("sem sessão limpa o que tinha ficado de outro chat", async () => {
    useProcessStore.setState({ processes: [processo(1, "outro-chat")] })

    await useProcessStore.getState().fetch()

    expect(useProcessStore.getState().processes).toEqual([])
  })

  it("com sessão pede a lista escopada e guarda", async () => {
    list.mockResolvedValue([processo(2, "s1")])

    await useProcessStore.getState().fetch("s1")

    expect(list).toHaveBeenCalledWith("s1")
    expect(useProcessStore.getState().processes).toEqual([processo(2, "s1")])
  })
})
