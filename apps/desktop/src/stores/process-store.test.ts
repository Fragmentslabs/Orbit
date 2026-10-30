import { beforeEach, describe, expect, it, vi } from "vitest"

const list = vi.fn()
const kill = vi.fn()

vi.mock("@/src/lib/ipc", () => ({ processApi: { list, kill } }))

const { useProcessStore } = await import("./process-store")

import type { ProcessInfo } from "@/src/lib/ipc"

function process(pid: number, sessionId?: string): ProcessInfo {
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

describe("conversation processes", () => {
  beforeEach(() => {
    list.mockReset()
    kill.mockReset()
    useProcessStore.setState({ processes: [] })
  })

  // The panel footer (and the browser's start screen) show the processes of the
  // OPEN chat. A new chat does not have a session yet — and asking for the list without a filter
  // returned the one from all chats, which is how a code chat's dev server
  // ended up showing inside a regular chat.
  it("with no session it does not reach main — the list stays empty", async () => {
    await useProcessStore.getState().fetch()

    expect(list).not.toHaveBeenCalled()
    expect(useProcessStore.getState().processes).toEqual([])
  })

  it("with no session it clears whatever was left from another chat", async () => {
    useProcessStore.setState({ processes: [process(1, "outro-chat")] })

    await useProcessStore.getState().fetch()

    expect(useProcessStore.getState().processes).toEqual([])
  })

  it("with a session it asks for the scoped list and stores it", async () => {
    list.mockResolvedValue([process(2, "s1")])

    await useProcessStore.getState().fetch("s1")

    expect(list).toHaveBeenCalledWith("s1")
    expect(useProcessStore.getState().processes).toEqual([process(2, "s1")])
  })
})
