import { panelApi } from "@/src/lib/ipc"

/**
 * Pool de `<webview>` persistentes do painel direito.
 *
 * O elemento `<webview>` de cada aba Browser é criado UMA vez por
 * `sessionId:tabId` e vive fora do ciclo de vida do React — quando a aba é
 * desmontada (troca de chat/aba) o elemento é apenas MOVIDO para um host
 * oculto fora da tela, mantendo a página viva (DOM, JS, scroll, histórico).
 *
 * Isso permite:
 * - voltar a uma sessão e encontrar o browser exatamente onde estava;
 * - o agente continuar navegando em background via tools panel_* (o WebContents
 *   segue registrado no main durante o "detach").
 *
 * O host oculto não usa display:none porque o guest precisa de viewport para
 * continuar renderizando e permitir capturePage — fica off-screen com
 * opacity:0, tamanho fixo razoável, fora do fluxo de interação.
 */

export interface WebviewElement extends HTMLElement {
  src: string
  getWebContentsId(): number
  getURL(): string
  loadURL(url: string): Promise<void>
  reload(): void
  executeJavaScript(code: string): Promise<unknown>
  isLoading(): boolean
}

interface WebviewRecord {
  key: string
  el: WebviewElement
  onNavigate?: (url: string) => void
  onConsoleMessage?: (message: string) => void
}

/** Tamanho do host oculto — só importa enquanto a aba está "desmontada". */
const HIDDEN_WIDTH = 1280
const HIDDEN_HEIGHT = 800

const records = new Map<string, WebviewRecord>()

let hiddenHost: HTMLDivElement | null = null

function getHiddenHost(): HTMLDivElement {
  if (!hiddenHost) {
    hiddenHost = document.createElement("div")
    hiddenHost.style.cssText =
      `position: fixed; top: -10000px; left: -10000px; width: ${HIDDEN_WIDTH}px; height: ${HIDDEN_HEIGHT}px;` +
      "opacity: 0; pointer-events: none; z-index: -1;"
    document.body.appendChild(hiddenHost)
  }
  return hiddenHost
}

function createWebview(src: string): WebviewElement {
  // @ts-ignore — tag específica do Electron
  const el = document.createElement("webview") as WebviewElement
  el.src = src || "about:blank"
  el.style.cssText = "width: 100%; height: 100%; display: flex; background: white; border: 0;"
  return el
}

function navigateUrl(event: Event): string | undefined {
  const url = (event as Event & { url?: string }).url
  return url && url !== "about:blank" ? url : undefined
}

/** A chave é `${sessionId}:${tabId}` — extrai o sessionId (nanoid, sem ":"). */
function sessionIdOf(key: string): string {
  const idx = key.indexOf(":")
  return idx >= 0 ? key.slice(0, idx) : key
}

/**
 * Garante que o webview da chave existe (criando no host oculto se preciso).
 * Callbacks são atualizados a cada chamada — o componente montado define o
 * callback do momento; desmontado, ficam undefined.
 */
export function ensureWebview(
  key: string,
  src?: string,
  onNavigate?: (url: string) => void,
  onConsoleMessage?: (message: string) => void,
): WebviewElement {
  let record = records.get(key)
  if (!record) {
    const el = createWebview(src ?? "")
    const rec: WebviewRecord = { key, el, onNavigate, onConsoleMessage }
    record = rec
    records.set(key, rec)

    el.addEventListener("dom-ready", () => {
      try {
        const wcId = el.getWebContentsId()
        if (wcId > 0) panelApi.register(sessionIdOf(key), wcId)
      } catch {
        // guest ainda não pronto — o próximo dom-ready registra
      }
    })
    const syncUrl = (event: Event) => {
      const url = navigateUrl(event)
      if (url) rec.onNavigate?.(url)
    }
    el.addEventListener("did-navigate", syncUrl)
    el.addEventListener("did-navigate-in-page", syncUrl)
    el.addEventListener("console-message", (event) => {
      const message = (event as Event & { message?: string }).message
      if (message) rec.onConsoleMessage?.(message)
    })
    getHiddenHost().appendChild(el)
  } else {
    record.onNavigate = onNavigate
    record.onConsoleMessage = onConsoleMessage
  }
  return record.el
}

/** reforça o registro quando a aba foi re-montada — mantém o main apontando pra cá. */
function reRegister(el: WebviewElement, sessionId: string): void {
  try {
    const wcId = el.getWebContentsId()
    if (wcId > 0) panelApi.register(sessionId, wcId)
  } catch {
    // o dom-ready tratará
  }
}

/**
 * Monta o webview da chave no container visível da aba (move do host oculto,
 * não recria). Retorna o elemento para o componente usar (loadURL, JS...).
 */
export function mountWebview(
  key: string,
  container: HTMLElement,
  src?: string,
  onNavigate?: (url: string) => void,
  onConsoleMessage?: (message: string) => void,
): WebviewElement {
  const el = ensureWebview(key, src, onNavigate, onConsoleMessage)
  if (el.parentElement !== container) container.appendChild(el)
  reRegister(el, sessionIdOf(key))
  return el
}

/** Desmonta: devolve ao host oculto — página, estado e registro continuam vivos. */
export function unmountWebview(key: string): void {
  const record = records.get(key)
  if (!record) return
  record.onNavigate = undefined
  const hidden = getHiddenHost()
  if (record.el.parentElement !== hidden) hidden.appendChild(record.el)
}

export function getWebview(key: string): WebviewElement | null {
  return records.get(key)?.el ?? null
}

export function reloadWebview(key: string): void {
  const el = records.get(key)?.el
  if (!el) return
  try {
    el.reload()
  } catch {
    // webview não pronto
  }
}

/** Destrói o webview da chave (fecho da aba) — limpa o registro no main. */
export function destroyWebview(key: string): void {
  const record = records.get(key)
  if (!record) return
  record.el.remove()
  records.delete(key)
  panelApi.register(sessionIdOf(key), null)
}