import { describe, expect, it, vi } from "vitest"

/**
 * Teste de VIDA do pool de <webview>, com um DOM de mentira.
 *
 * O defeito que motivou o arquivo não era do Electron (ele se comporta como
 * documentado) e sim do POOL: o <webview> era MOVIDO de pai (host oculto ↔
 * container visível) e reaproveitado. Quando o elemento era reanexado antes
 * do primeiro guest terminar de nascer, o Electron criava dois guests para o
 * mesmo elemento, o renderer guardava o id do guest morto e a aba ficava
 * BRANCA para sempre ("Invalid guestInstanceId" no console).
 *
 * A regra que estes testes fixam: o <webview> NUNCA muda de pai. Ele nasce no
 * container onde vai ficar e é REMOVIDO (não movido) quando a aba desmonta.
 */

/** Elemento de mentira: só o que o pool usa. */
class FakeElement {
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  style = { cssText: "" }
  src = ""
  partition = ""
  private listeners: Record<string, Array<(event: unknown) => void>> = {}

  constructor(readonly tagName: string) {}

  addEventListener(type: string, cb: (event: unknown) => void): void {
    const lista = this.listeners[type] ?? []
    lista.push(cb)
    this.listeners[type] = lista
  }

  emit(type: string): void {
    for (const cb of this.listeners[type] ?? []) cb({ type })
  }

  /** Simula o guest vivo: o Electron devolve o webContentsId. */
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

  // Guest nunca pronto: o pool só usa isso depois do dom-ready.
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

/** O container visível da aba (o React providing). */
function container(): FakeElement {
  return new FakeElement("div")
}

describe("ciclo de vida do <webview>", () => {
  it("cria um elemento NOVO a cada montagem e nunca o re-aproveita", () => {
    const box = container()
    const primeiro = mountWebview("sessao:aba", box as unknown as HTMLElement)
    expect(primeiro.parentElement).toBe(box)

    unmountWebview("sessao:aba")
    // Desmontar REMOVE o elemento — não devolve ele para outro pai.
    expect(primeiro.parentElement).toBe(null)

    const segundo = mountWebview("sessao:aba", box as unknown as HTMLElement)
    expect(segundo).not.toBe(primeiro)
    expect(segundo.parentElement).toBe(box)
  })

  it("não mexe no elemento quando a aba re-renderiza no mesmo container", () => {
    const box = container()
    const primeiro = mountWebview("sessao:aba2", box as unknown as HTMLElement)
    const segundo = mountWebview("sessao:aba2", box as unknown as HTMLElement)
    expect(segundo).toBe(primeiro)
  })

  it("não devolve o elemento da aba ao host oculto (era o re-parent que corrompia o guest)", () => {
    const box = container()
    mountWebview("sessao:aba3", box as unknown as HTMLElement)
    unmountWebview("sessao:aba3")
    // O host oculto (único filho do body) não existe: nada foi para lá.
    expect(body.children).toHaveLength(0)
  })

  it("mantém a URL da aba entre mount e unmount", () => {
    const box = container()
    mountWebview("sessao:aba4", box as unknown as HTMLElement, "https://exemplo.com/busca")
    expect(getWebviewUrl("sessao:aba4")).toBe("https://exemplo.com/busca")
    unmountWebview("sessao:aba4")
    expect(getWebviewUrl("sessao:aba4")).toBe("https://exemplo.com/busca")
  })

  it("o browser do agente nasce no host oculto e fica lá", () => {
    ensureAgentBrowser("sessao-agente")
    const host = body.children[0]
    expect(host).toBeDefined()
    expect(host.children).toHaveLength(1)
    expect(host.children[0].tagName).toBe("webview")
  })

  it("registra o guest no main e solta o registro quando a aba desmonta", () => {
    const box = container()
    const el = mountWebview("sessao:aba5", box as unknown as HTMLElement) as unknown as FakeElement

    // O guest nasce: o Electron passa a devolver o webContentsId.
    el.guestId = 42
    el.emit("dom-ready")
    expect(send).toHaveBeenCalledWith("panel:register", "sessao", 42)

    send.mockClear()
    unmountWebview("sessao:aba5")
    // O guest morreu: o main precisa saber, senão as tools miram um
    // webContents destruído.
    expect(send).toHaveBeenCalledWith("panel:unregister", "sessao", 42)
  })
})
