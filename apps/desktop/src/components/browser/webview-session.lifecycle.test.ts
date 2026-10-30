import { describe, expect, it, vi } from "vitest"

/**
 * LIFE test of the <webview> pool, with a fake DOM.
 *
 * The defect that motivated the file was not Electron's (it behaves as
 * documented) but the POOL's: the <webview> was MOVED from parent (hidden host ↔
 * visible container) and reused. When the element was re-attached before
 * the first guest finished being born, Electron created two guests for the
 * same element, the renderer kept the id of the dead guest and the tab stayed
 * WHITE forever ("Invalid guestInstanceId" in the console).
 *
 * The rule these tests pin down: the <webview> NEVER changes parent. It is born in the
 * container where it is going to stay and is REMOVED (not moved) when the tab unmounts.
 */

/** Fake element: only what the pool uses. */
class FakeElement {
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  style = { cssText: "" }
  src = ""
  partition = ""
  private listeners: Record<string, Array<(event: unknown) => void>> = {}

  constructor(readonly tagName: string) {}

  addEventListener(type: string, cb: (event: unknown) => void): void {
    const list = this.listeners[type] ?? []
    list.push(cb)
    this.listeners[type] = list
  }

  emit(type: string): void {
    for (const cb of this.listeners[type] ?? []) cb({ type })
  }

  /** Simulates the live guest: Electron returns the webContentsId. */
  guestId = 0

  getWebContentsId(): number {
    if (!this.guestId) {
      throw new Error("The WebView must be attached to the DOM and the guest must be initialized")
    }
    return this.guestId
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement?.removeChild(child)
    child.parentElement = this
    this.children.push(child)
    return child
  }

  removeChild(child: FakeElement): FakeElement {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    child.parentElement = null
    return child
  }

  remove(): void {
    this.parentElement?.removeChild(this)
  }

  // Guest never ready: the pool only uses that after dom-ready.
  getURL(): string {
    return "about:blank"
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  reload(): void {}
  executeJavaScript(): Promise<unknown> {
    return Promise.resolve(undefined)
  }
  isLoading(): boolean {
    return false
  }
}

const body = new FakeElement("body")

const send = vi.fn()

vi.stubGlobal("window", {
  platform: "test",
  ipcRenderer: { send, on: vi.fn(), off: vi.fn(), invoke: vi.fn() },
})
vi.stubGlobal("document", {
  body,
  createElement: (tag: string) => new FakeElement(tag),
})

const { ensureAgentBrowser, getWebviewUrl, mountWebview, unmountWebview } = await import(
  "./webview-session"
)

/** The visible container of the tab (the React provider). */
function container(): FakeElement {
  return new FakeElement("div")
}

describe("lifecycle of the <webview>", () => {
  it("creates a NEW element on every mount and never reuses it", () => {
    const box = container()
    const first = mountWebview("session:tab", box as unknown as HTMLElement)
    expect(first.parentElement).toBe(box)

    unmountWebview("session:tab")
    // Unmounting REMOVES the element — it does not hand it back to another parent.
    expect(first.parentElement).toBe(null)

    const second = mountWebview("session:tab", box as unknown as HTMLElement)
    expect(second).not.toBe(first)
    expect(second.parentElement).toBe(box)
  })

  it("leaves the element alone when the tab re-renders in the same container", () => {
    const box = container()
    const first = mountWebview("session:tab2", box as unknown as HTMLElement)
    const second = mountWebview("session:tab2", box as unknown as HTMLElement)
    expect(second).toBe(first)
  })

  it("does not give the tab's element back to the hidden host (the re-parent was corrupting the guest)", () => {
    const box = container()
    mountWebview("session:tab3", box as unknown as HTMLElement)
    unmountWebview("session:tab3")
    // The hidden host (only child of the body) does not exist: nothing went there.
    expect(body.children).toHaveLength(0)
  })

  it("keeps the tab's URL between mount and unmount", () => {
    const box = container()
    mountWebview("session:tab4", box as unknown as HTMLElement, "https://example.com/search")
    expect(getWebviewUrl("session:tab4")).toBe("https://example.com/search")
    unmountWebview("session:tab4")
    expect(getWebviewUrl("session:tab4")).toBe("https://example.com/search")
  })

  it("the agent's browser is born in the hidden host and stays there", () => {
    ensureAgentBrowser("agent-session")
    const host = body.children[0]
    expect(host).toBeDefined()
    expect(host.children).toHaveLength(1)
    expect(host.children[0].tagName).toBe("webview")
  })

  it("registers the guest in main and releases the registration when the tab unmounts", () => {
    const box = container()
    const el = mountWebview("session:tab5", box as unknown as HTMLElement) as unknown as FakeElement

    // The guest is born: Electron starts returning the webContentsId.
    el.guestId = 42
    el.emit("dom-ready")
    expect(send).toHaveBeenCalledWith("panel:register", "session", 42)

    send.mockClear()
    unmountWebview("session:tab5")
    // The guest died: the main process needs to know, otherwise the tools aim at a
    // destroyed webContents.
    expect(send).toHaveBeenCalledWith("panel:unregister", "session", 42)
  })
})
