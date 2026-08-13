import { panelApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Pool de `<webview>` do painel direito — um por `sessionId:tabId`.
 *
 * IMPORTANTE (medido, não suposto): o Electron DESTRÓI e RECRIA o guest toda
 * vez que o elemento `<webview>` muda de pai no DOM. A cada re-parent o
 * webContentsId muda, `dom-ready` dispara de novo e a página é recarregada a
 * partir do atributo `src` — o estado JS da página NÃO sobrevive. Não existe
 * "mover o elemento e manter a página viva".
 *
 * Por isso o pool guarda a URL ATUAL de cada aba (`currentUrl`, alimentada
 * pelos eventos de navegação, inclusive quando quem navega é o agente) e a
 * restaura assim que o guest renasce. O que persiste de fato:
 * - a URL da aba (volta na mesma página ao trocar de aba/chat);
 * - cookies, logins e localStorage (partition `persist:` — sobrevive até a
 *   reinicialização do app);
 * - o modo seleção, re-injetado a cada guest novo.
 *
 * O que não persiste é o estado em memória da página (formulário preenchido,
 * scroll, SPA state) — limitação do `<webview>`, não uma escolha nossa.
 */

/** Sessão persistente do browser do painel: cookies/logins/localStorage em
 *  disco, compartilhada com a janela oculta de captura (browser-script.ts). */
export const BROWSER_PARTITION = "persist:orbit-browser"

export interface WebviewElement extends HTMLElement {
  src: string
  partition: string
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
  /** URL autoritativa da aba — sobrevive à recriação do guest. */
  currentUrl: string
  /** URL que já pedimos para este guest. Impede que o restauro se repita
   *  quando a URL carregada não bate exatamente com a pedida (o Chromium
   *  normaliza URLs) — sem esse trava, dom-ready e loadURL se realimentam num
   *  laço infinito de ERR_ABORTED. Zerado a cada guest novo (mount/unmount). */
  requestedUrl: string | null
  /** true quando o elemento está no container visível de uma aba. */
  mounted: boolean
  onNavigate?: (url: string) => void
}

/** Tamanho do host oculto — só importa enquanto a aba está "desmontada". */
const HIDDEN_WIDTH = 1280
const HIDDEN_HEIGHT = 800

const records = new Map<string, WebviewRecord>()

// ─── Modo seleção ────────────────────────────────────────────────────────────

/** Prefixo do payload de seleção que a página manda por console.log. */
const SELECT_PREFIX = "__ORBIT_SELECT__"

/**
 * Injetado na página quando o modo seleção está ligado. É de UM tiro: ao
 * clicar, envia o payload e se desarma sozinho — o store espelha isso
 * (addSelection zera selectMode), então o botão nunca fica aceso sem os
 * listeners estarem de fato ativos.
 */
const SELECT_ON = `(() => {
  if (window.__orbitSelectCleanup) window.__orbitSelectCleanup()
  let last = null
  const restore = () => { if (last) { last.style.outline = last.__orbitOutline || ''; last = null } }
  const over = (e) => {
    restore()
    last = e.target
    last.__orbitOutline = last.style.outline
    last.style.outline = '2px solid #22c55e'
  }
  const cssPath = (el) => {
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id) { parts.unshift('#' + node.id); break }
      let part = node.tagName.toLowerCase()
      const cls = [...node.classList].slice(0, 2).join('.')
      if (cls) part += '.' + cls
      const parent = node.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  const click = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.target
    console.log('${SELECT_PREFIX}' + JSON.stringify({
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      text: (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
      html: el.outerHTML.slice(0, 1500),
      url: location.href,
    }))
    window.__orbitSelectCleanup()
  }
  document.addEventListener('mouseover', over, true)
  document.addEventListener('click', click, true)
  window.__orbitSelectCleanup = () => {
    document.removeEventListener('mouseover', over, true)
    document.removeEventListener('click', click, true)
    restore()
    window.__orbitSelectCleanup = null
  }
})()`

const SELECT_OFF = `window.__orbitSelectCleanup && window.__orbitSelectCleanup()`

// ─── Acesso seguro ao guest ──────────────────────────────────────────────────

/**
 * true quando o guest está anexado e já emitiu dom-ready. É uma verificação AO
 * VIVO: `getWebContentsId()` lança exatamente enquanto essas condições não
 * valem. Um cache (WeakSet "já ficou pronto") mentiria depois de cada
 * re-parent, que é quando o guest é recriado — foi essa mentira que derrubava
 * a árvore React com "The WebView must be attached to the DOM...".
 */
export function isWebviewReady(el: WebviewElement): boolean {
  try {
    return el.getWebContentsId() > 0
  } catch {
    return false
  }
}

/** getURL() que nunca lança: "" enquanto o guest não estiver pronto. */
export function safeWebviewURL(el: WebviewElement): string {
  if (!isWebviewReady(el)) return ""
  try {
    return el.getURL()
  } catch {
    return ""
  }
}

function run(el: WebviewElement, code: string): void {
  if (!isWebviewReady(el)) return
  try {
    void el.executeJavaScript(code).catch(() => {})
  } catch {
    // guest morreu entre o check e a chamada — o próximo dom-ready re-aplica
  }
}

/** A chave é `${sessionId}:${tabId}` — extrai o sessionId (nanoid, sem ":"). */
function sessionIdOf(key: string): string {
  const idx = key.indexOf(":")
  return idx >= 0 ? key.slice(0, idx) : key
}

/** A chave é `${sessionId}:${tabId}` — extrai o tabId. */
function tabIdOf(key: string): string {
  const idx = key.indexOf(":")
  return idx >= 0 ? key.slice(idx + 1) : key
}

function isRealUrl(url: string | undefined): url is string {
  return !!url && url !== "about:blank"
}

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

/**
 * O `src` fica FIXO em about:blank pelo resto da vida do elemento. Ele é o que
 * o guest recriado carrega a cada re-parent: se apontasse para uma página real,
 * toda troca de aba recarregaria a página ANTIGA antes de irmos para a atual —
 * e mexer em `src` com o elemento anexado dispara uma navegação, que realimenta
 * o handler de navegação num laço. Quem manda na página é `currentUrl`, via
 * restoreGuest.
 */
function createWebview(): WebviewElement {
  const el = document.createElement("webview") as WebviewElement
  // partition precisa ser definida ANTES de anexar ao DOM (depois é imutável)
  el.partition = BROWSER_PARTITION
  el.src = "about:blank"
  el.style.cssText = "width: 100%; height: 100%; display: flex; background: white; border: 0;"
  return el
}

// ─── Ciclo de vida ───────────────────────────────────────────────────────────

/** Aplica no guest o estado que precisa sobreviver à recriação: URL e seleção. */
function restoreGuest(record: WebviewRecord): void {
  const { el } = record
  if (!isWebviewReady(el)) return

  // Registra SEMPRE, montado ou não: com o painel fechado o guest vive no host
  // oculto e continua sendo o alvo das tools panel_* do agente (é o browser em
  // segundo plano). Quando há mais de um guest da mesma sessão, o último
  // dom-ready vence — na troca de abas o guest visível é sempre o último a
  // renascer (unmount → mount), então ele mantém o registro.
  try {
    const wcId = el.getWebContentsId()
    if (wcId > 0) panelApi.register(sessionIdOf(record.key), wcId)
  } catch {
    // o próximo dom-ready registra
  }

  const target = record.currentUrl
  if (isRealUrl(target) && record.requestedUrl !== target && safeWebviewURL(el) !== target) {
    record.requestedUrl = target
    try {
      void el.loadURL(target).catch(() => {})
    } catch {
      record.requestedUrl = null
    }
  }

  run(el, usePanelStore.getState().selectMode ? SELECT_ON : SELECT_OFF)
}

/** Registra a URL como a atual da aba e propaga para a UI e para o store. */
function reportUrl(record: WebviewRecord, url: string): void {
  if (!isRealUrl(url) || record.currentUrl === url) return
  // Redirect do servidor durante um restauro também passa por aqui: a URL que
  // o guest realmente carregou vira a atual da aba.
  record.currentUrl = url
  record.onNavigate?.(url)
  // Persiste na aba mesmo com o componente desmontado (agente navegando em
  // background) — é o que faz a URL sobreviver a sair e voltar do chat.
  usePanelStore.getState().setTabUrl(sessionIdOf(record.key), tabIdOf(record.key), url)
}

function handleConsoleMessage(message: string): void {
  if (!message.startsWith(SELECT_PREFIX)) return
  try {
    usePanelStore.getState().addSelection(JSON.parse(message.slice(SELECT_PREFIX.length)))
  } catch {
    // payload malformado — ignora
  }
}

/**
 * Garante que o webview da chave existe (criando no host oculto se preciso).
 * O callback de navegação é atualizado a cada chamada — o componente montado
 * define o do momento; desmontado, fica undefined.
 */
export function ensureWebview(
  key: string,
  src?: string,
  onNavigate?: (url: string) => void,
): WebviewElement {
  const existing = records.get(key)
  if (existing) {
    existing.onNavigate = onNavigate
    return existing.el
  }

  const el = createWebview()
  const record: WebviewRecord = {
    key,
    el,
    currentUrl: isRealUrl(src) ? src : "",
    requestedUrl: null,
    mounted: false,
    onNavigate,
  }
  records.set(key, record)

  // dom-ready dispara a cada attach/re-attach (guest novo) — é o gancho para
  // devolver o guest ao estado da aba.
  el.addEventListener("dom-ready", () => restoreGuest(record))

  const syncUrl = (event: Event) => {
    const url = (event as Event & { url?: string }).url
    if (url) reportUrl(record, url)
  }
  el.addEventListener("did-navigate", syncUrl)
  el.addEventListener("did-navigate-in-page", syncUrl)
  el.addEventListener("console-message", (event) => {
    const message = (event as Event & { message?: string }).message
    if (message) handleConsoleMessage(message)
  })

  getHiddenHost().appendChild(el)
  return el
}

/**
 * Monta o webview da chave no container visível da aba. Isso RECRIA o guest
 * (limitação do Electron) — o restoreGuest do dom-ready devolve a página.
 */
export function mountWebview(
  key: string,
  container: HTMLElement,
  src?: string,
  onNavigate?: (url: string) => void,
): WebviewElement {
  const el = ensureWebview(key, src, onNavigate)
  const record = records.get(key)!
  record.mounted = true
  if (el.parentElement !== container) {
    // Guest novo a caminho: o restauro desta geração ainda não foi tentado.
    record.requestedUrl = null
    container.appendChild(el)
  }
  // Guest já vivo (mesmo container): reaplica o estado sem esperar dom-ready.
  restoreGuest(record)
  return el
}

/** Desmonta: devolve ao host oculto. A página é recarregada ao voltar. */
export function unmountWebview(key: string): void {
  const record = records.get(key)
  if (!record) return
  record.onNavigate = undefined
  record.mounted = false
  const hidden = getHiddenHost()
  if (record.el.parentElement !== hidden) {
    record.requestedUrl = null
    hidden.appendChild(record.el)
  }
}

export function getWebview(key: string): WebviewElement | null {
  return records.get(key)?.el ?? null
}

/** URL atual conhecida da aba — não toca no guest, então nunca lança. */
export function getWebviewUrl(key: string): string {
  return records.get(key)?.currentUrl ?? ""
}

/** Chave canônica do browser do agente numa sessão (chat/task). */
function agentKey(sessionId: string): string {
  return `${sessionId}:browser-agent`
}

/**
 * Garante o webview do AGENTE da sessão existindo no host OCULTO (sem abrir a
 * UI). Usado quando o agente precisa do browser com o painel fechado: o guest
 * nasce escondido, registra no main no dom-ready e as tools panel_* passam a
 * agir nele. A aba da UI (se existir) reanexa o MESMO webview ao ser montada.
 */
export function ensureAgentBrowser(sessionId: string, url?: string): void {
  if (!sessionId) return
  const key = agentKey(sessionId)
  ensureWebview(key, url)
  if (url) navigateWebview(key, url)
}

/** Navega a aba. Guest não pronto: a URL fica como atual e o dom-ready aplica. */
export function navigateWebview(key: string, url: string): void {
  const record = records.get(key)
  if (!record || !isRealUrl(url) || record.currentUrl === url) return
  record.currentUrl = url
  if (!isWebviewReady(record.el)) {
    // Guest não pronto: o dom-ready leva para a URL nova.
    record.requestedUrl = null
    return
  }
  record.requestedUrl = url
  try {
    void record.el.loadURL(url).catch(() => {})
  } catch {
    record.requestedUrl = null // dom-ready seguinte restaura
  }
}

/** Recarrega a página da aba, sem recriar o elemento. */
export function reloadWebview(key: string): void {
  const record = records.get(key)
  if (!record || !isWebviewReady(record.el)) return
  try {
    record.el.reload()
  } catch {
    // guest trocado entre o check e a chamada — nada a recarregar
  }
}

/** Liga/desliga o modo seleção na página da aba (re-aplicado a cada guest novo). */
export function applySelectMode(key: string, on: boolean): void {
  const record = records.get(key)
  if (!record) return
  run(record.el, on ? SELECT_ON : SELECT_OFF)
}

/** Destrói o webview da chave (fecho da aba) — limpa o registro no main. */
export function destroyWebview(key: string): void {
  const record = records.get(key)
  if (!record) return
  record.el.remove()
  records.delete(key)
  panelApi.register(sessionIdOf(key), null)
}
