import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { voiceApi } from "./voice-ipc"

/**
 * Ponte de mentira com a mesma forma do preload: `on` registra o listener e
 * devolve o wrapper que o `off` precisa receber de volta.
 */
function fakeBridge() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const invoke = vi.fn((channel: string) => Promise.resolve({ channel }))
  const ipc = {
    invoke,
    send: vi.fn(),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set<(...args: unknown[]) => void>()
      set.add(listener)
      listeners.set(channel, set)
      return listener
    },
    off: (channel: string, wrapper: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(wrapper)
    },
  }
  return {
    ipc,
    invoke,
    emit: (channel: string, payload?: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload)
    },
    count: (channel: string) => listeners.get(channel)?.size ?? 0,
  }
}

let bridge: ReturnType<typeof fakeBridge>

beforeEach(() => {
  bridge = fakeBridge()
  Object.defineProperty(globalThis, "window", {
    value: { ipcRenderer: bridge.ipc },
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window")
})

describe("voiceApi.onStatusChanged", () => {
  it("escuta o canal de mudança de estado e entrega o payload", () => {
    const seen: unknown[] = []
    const unsubscribe = voiceApi.onStatusChanged((status) => seen.push(status))

    expect(bridge.count("voice:status-changed")).toBe(1)

    bridge.emit("voice:status-changed", { ttsReady: true })

    expect(seen).toEqual([{ ttsReady: true }])

    unsubscribe()

    expect(bridge.count("voice:status-changed")).toBe(0)

    bridge.emit("voice:status-changed", { ttsReady: false })

    expect(seen).toEqual([{ ttsReady: true }])
  })

  it("não confunde os canais: o progresso do download segue separado", () => {
    const status: unknown[] = []
    const progress: unknown[] = []
    voiceApi.onStatusChanged((raw) => status.push(raw))
    voiceApi.onDownloadProgress((event) => progress.push(event))

    bridge.emit("voice:download-progress", { modelId: "tts", done: true })
    bridge.emit("voice:status-changed", { ttsReady: true })

    expect(progress).toEqual([{ modelId: "tts", done: true }])
    expect(status).toEqual([{ ttsReady: true }])
  })

  it("o `status()` continua sendo um invoke no canal de sempre", async () => {
    await voiceApi.status()

    expect(bridge.invoke).toHaveBeenCalledWith("voice:status")
  })
})
