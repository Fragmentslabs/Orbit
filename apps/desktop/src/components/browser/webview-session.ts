import { panelApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Pool de `<webview>` do painel direito — um por `sessionId:tabId`.
 *
 * O ELEMENTO é descartável (medido no Electron 44, não suposto): o guest do
 * `<webview>` é destruído quando o elemento sai do DOM e criado de novo quando
 * ele volta. A versão anterior reaproveitava o MESMO elemento, mudando-o de
 * pai (host oculto ↔ container visível) — e aí nascia o defeito:
 *
 * - se o elemento era reanexado antes de o primeiro guest terminar de nascer,
 *   o Electron criava DOIS guests para o mesmo elemento e o renderer acabava
 *   guardando o id do guest que já tinha morrido;
 * - com esse id morto, o próximo detach/atach falhava com "Invalid
 *   guestInstanceId: N" no console;
 * - e a aba ficava BRANCA para sempre: o `reset()` do Electron (que roda
 *   DEPOIS do detach) era pulado pelo erro, então `beforeFirstNavigation`
 *   continuava falso e o elemento nunca mais criava um guest — nem recarregando.
 *
 * Agora cada MONTAGEM cria um `<webview>` novo, direto no container visível,
 * e cada DESMONTAGEM o remove do DOM. O elemento nunca muda de pai e nunca é
 * reaproveitado: nasce no lugar onde vai ficar e morre quando sai de lá.
 *
 * O que sobrevive é o ESTADO da aba (a URL), guardado no registro do pool:
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
  /** <webview> vivo. null quando não há elemento na tela (aba desmontada ou
   *  elemento descartado). */
  el: WebviewElement | null
  /** Último webContents do guest registrado no main. Guardado porque o
   *  elemento já desconectado não devolve mais o id (o Electron zera o
   *  guestInstanceId no reset) — e é ele que precisa ser solto no main. */
  wcId: number | null
  /** URL autoritativa da aba — sobrevive à recriação do guest. */
  currentUrl: string
  /** URL que já pedimos para este guest. Impede que o restauro se repita
   *  quando a URL carregada não bate exatamente com a pedida (o Chromium
   *  normaliza URLs) — sem essa trava, dom-ready e loadURL se realimentam num
   *  laço infinito de ERR_ABORTED. Zerado a cada guest novo (mount/unmount) e
   *  também quando a navegação não chega a commitar: com o guest em branco a
   *  trava não vale, senão ele fica preso em about:blank para sempre. */
  requestedUrl: string | null
  /** true quando o elemento está no container visível de uma aba. */
  mounted: boolean
  onNavigate?: (url: string) => void
  /** Último acesso conhecido — base do eviction de webviews desmontados. */
  lastUsed: number
}

/** Tamanho do host oculto quando NÃO há viewport definido (equivale ao painel
 *  aberto preenchendo o container). */
const HIDDEN_WIDTH = 1280
const HIDDEN_HEIGHT = 800

/**
 * Tamanho efetivo do host oculto: quando o agente define um viewport
 * (panel_resize), o browser em segundo plano renderiza nele — o screenshot
 * sai no tamanho escolhido MESMO com o painel fechado (teste de
 * responsividade em background de verdade). Sem viewport, assume o tamanho
 * padrão do painel.
 */
function hiddenHostSize(): { width: number; height: number } {
  const viewport = usePanelStore.getState().viewport
  return viewport
    ? { width: viewport.width, height: viewport.height }
    : { width: HIDDEN_WIDTH, height: HIDDEN_HEIGHT }
}

/**
 * TTL de webviews desmontados (aba fechada e browser do agente ocioso): depois
 * deste tempo sem uso, o registro é limpo. O custo de destruir é zero — a
 * próxima tool de browser recria o webview e navega para a URL que ela pede (o
 * store guarda a última URL da aba).
 */
export const EVICT_TTL_MS = 10 * 60 * 1000

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

/**
 * Decide se o restauro deve pedir a URL ao guest.
 *
 * PURA de propósito: é a única parte desta corrida que dá para testar sem
 * Electron, e é exatamente onde morava o defeito. `requestedUrl` existe para o
 * laço de normalização do Chromium (a URL carregada não bate exatamente com a
 * pedida, então `guestUrl !== target` sozinho nunca fecharia e dom-ready +
 * loadURL se realimentariam num ERR_ABORTED infinito). Mas a trava só pode valer
 * se o guest chegou a carregar ALGO: com o guest em branco a tentativa anterior
 * não commitou, e insistir é o certo — sem isso nada mais carrega, porque o
 * guarda de navigateWebview também só olhava a URL PEDIDA, nunca o guest.
 */
export function shouldRestoreGuest(
  target: string,
  guestUrl: string,
  requestedUrl: string | null,
): boolean {
  if (!isRealUrl(target) || guestUrl === target) return false
  return !(requestedUrl === target && isRealUrl(guestUrl))
}

/**
 * Decide se navigateWebview deve agir. Pura pelo mesmo motivo: pular só porque
 * `currentUrl === url` deixava a aba presa quando o guest estava em branco — a
 * URL atual já era a certa, ninguém carregava nada e o restauro também recusava.
 */
export function shouldNavigate(currentUrl: string, url: string, guestUrl: string): boolean {
  if (!isRealUrl(url)) return false
  return !(currentUrl === url && isRealUrl(guestUrl))
}

let hiddenHost: HTMLDivElement | null = null

function getHiddenHost(): HTMLDivElement {
  if (!hiddenHost) {
    const size = hiddenHostSize()
    hiddenHost = document.createElement("div")
    hiddenHost.style.cssText =
      `position: fixed; top: -10000px; left: -10000px; width: ${size.width}px; height: ${size.height}px;` +
      "opacity: 0; pointer-events: none; z-index: -1;"
    document.body.appendChild(hiddenHost)
  }
  return hiddenHost
}

/**
 * Mantém o host oculto no tamanho do viewport do store (panel_resize do
 * agente). A UI visível já é dimensionada pelo wrapper do web-preview.tsx —
 * aqui é o equivalente para o browser em segundo plano com o painel fechado:
 * sem isso, o print sairia sempre em 1280×800, ignorando o viewport.
 */
function applyHiddenHostSize(): void {
  if (!hiddenHost) return
  const { width, height } = hiddenHostSize()
  if (hiddenHost.style.width !== `${width}px`) hiddenHost.style.width = `${width}px`
  if (hiddenHost.style.height !== `${height}px`) hiddenHost.style.height = `${height}px`
}

// O host oculto segue o viewport do store. Se o resize chegar antes de
// qualquer webview existir, o getHiddenHost() já cria no tamanho atual — o
// subscribe só precisa atualizar quando o host já foi criado.
usePanelStore.subscribe((state, prev) => {
  if (state.viewport !== prev.viewport) applyHiddenHostSize()
})

/**
 * O `src` fica FIXO em about:blank pelo resto da vida do elemento. Ele é o que
 * o guest recriado carrega a cada mount: se apontasse para uma página real,
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
  const el = record.el
  if (!el || !isWebviewReady(el)) return

  // Registra SEMPRE, montado ou não: com o painel fechado o guest vive no host
  // oculto e continua sendo o alvo das tools panel_* do agente (é o browser em
  // segundo plano).
  registerGuest(record)

  const target = record.currentUrl
  if (shouldRestoreGuest(target, safeWebviewURL(el), record.requestedUrl)) {
    record.requestedUrl = target
    try {
      void el.loadURL(target).catch(() => {
        // Não commitou: solta a trava para o próximo dom-ready tentar de novo.
        if (records.get(record.key) === record) record.requestedUrl = null
      })
    } catch {
      record.requestedUrl = null
    }
  }

  run(el, usePanelStore.getState().selectMode ? SELECT_ON : SELECT_OFF)
}

/** Registra o webContents do guest no main (alvo das tools panel_*). */
function registerGuest(record: WebviewRecord): void {
  const el = record.el
  if (!el) return
  try {
    const wcId = el.getWebContentsId()
    if (wcId > 0) {
      record.wcId = wcId
      panelApi.register(sessionIdOf(record.key), wcId)
    }
  } catch {
    // o próximo dom-ready registra
  }
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

/** Cria o elemento e liga os listeners. NÃO anexa ao DOM — quem anexa decide
 *  onde o elemento nasce (container visível ou host oculto), e ele nunca muda
 *  de pai depois disso. */
function createElement(record: WebviewRecord): WebviewElement {
  const el = createWebview()

  // dom-ready dispara quando o guest nasce (uma vez por elemento) — é o gancho
  // para devolver o guest ao estado da aba.
  el.addEventListener("dom-ready", () => {
    // elemento descartado no meio do caminho: o registro já é outro
    if (record.el !== el) return
    restoreGuest(record)
  })

  const syncUrl = (event: Event) => {
    if (record.el !== el) return
    const url = (event as Event & { url?: string }).url
    if (url) reportUrl(record, url)
  }
  el.addEventListener("did-navigate", syncUrl)
  el.addEventListener("did-navigate-in-page", syncUrl)
  el.addEventListener("console-message", (event) => {
    if (record.el !== el) return
    const message = (event as Event & { message?: string }).message
    if (message) handleConsoleMessage(message)
  })

  return el
}

/** Cria (ou reaproveita) o registro da chave. */
function ensureRecord(key: string, src?: string): WebviewRecord {
  const existing = records.get(key)
  if (existing) return existing
  const record: WebviewRecord = {
    key,
    el: null,
    wcId: null,
    currentUrl: isRealUrl(src) ? src : "",
    requestedUrl: null,
    mounted: false,
    lastUsed: Date.now(),
  }
  records.set(key, record)
  return record
}

/**
 * Descarta o elemento: ele sai do DOM (o guest morre com ele) e a referência
 * é solta. O registro (e a URL da aba) continua vivo.
 *
 * O elemento é DESCARTADO, nunca movido para outro pai: foi exatamente o
 * re-parent que corrompia o guest (ver o cabeçalho do arquivo).
 */
function disposeElement(record: WebviewRecord): void {
  const el = record.el
  if (!el) return
  record.el = null
  record.requestedUrl = null

  try {
    el.remove()
  } catch {
    // já estava fora do DOM
  }

  // O guest morreu com o elemento: solta o registro no main (só se ele for o
  // webContents deste webview — o browser do agente da sessão é outro).
  if (record.wcId) {
    panelApi.unregister(sessionIdOf(record.key), record.wcId)
    record.wcId = null
  }
}

/**
 * Monta o webview da chave no container visível da aba.
 *
 * Cada montagem cria um `<webview>` NOVO, já no container: o elemento nunca
 * muda de pai (é o que mantinha o guest corrupto) e nasce com um único guest.
 * A URL da aba é reaplicada no dom-ready, pelo pool.
 */
export function mountWebview(
  key: string,
  container: HTMLElement,
  src?: string,
  onNavigate?: (url: string) => void,
): WebviewElement {
  const record = ensureRecord(key, src)
  record.onNavigate = onNavigate
  record.lastUsed = Date.now()

  // Já está no lugar (re-render do React): reaplica o estado sem mexer no DOM.
  const current = record.el
  if (current && record.mounted && current.parentElement === container) {
    restoreGuest(record)
    return current
  }

  // Elemento novo: o anterior (se houver) é descartado, nunca reanexado.
  disposeElement(record)

  const el = createElement(record)
  record.el = el
  record.mounted = true
  record.requestedUrl = null
  container.appendChild(el)

  // Guest novo a caminho: o restauro desta geração ainda não foi tentado.
  restoreGuest(record)
  return el
}

/** Desmonta: o elemento sai do DOM e morre. A URL da aba fica no registro. */
export function unmountWebview(key: string): void {
  const record = records.get(key)
  if (!record) return
  record.onNavigate = undefined
  record.mounted = false
  disposeElement(record)
}

export function getWebview(key: string): WebviewElement | null {
  const record = records.get(key)
  if (record) record.lastUsed = Date.now()
  return record?.el ?? null
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
 * agir nele.
 *
 * O elemento do agente nasce NO host oculto e nunca é movido. Quando a aba
 * Browser da sessão é aberta na tela, o pool cria um elemento novo para o
 * container visível (mesma URL, mesma sessão) — o do host oculto é descartado.
 */
export function ensureAgentBrowser(sessionId: string, url?: string): void {
  if (!sessionId) return
  const key = agentKey(sessionId)
  const record = ensureRecord(key, url)
  if (!record.el) {
    const el = createElement(record)
    record.el = el
    record.requestedUrl = null
    getHiddenHost().appendChild(el)
  }
  if (url) navigateWebview(key, url)
  // O main pode ainda ter o webContents de um guest que já morreu: re-registra
  // o vivo para as tools panel_* acharem o alvo.
  registerGuest(record)
}

/** Navega a aba. Guest não pronto: a URL fica como atual e o dom-ready aplica. */
export function navigateWebview(key: string, url: string): void {
  const record = records.get(key)
  if (!record) return
  const guestUrl = record.el ? safeWebviewURL(record.el) : ""
  if (!shouldNavigate(record.currentUrl, url, guestUrl)) return
  record.lastUsed = Date.now()
  record.currentUrl = url
  if (!record.el || !isWebviewReady(record.el)) {
    // Guest não pronto: o dom-ready leva para a URL nova.
    record.requestedUrl = null
    return
  }
  record.requestedUrl = url
  try {
    void record.el.loadURL(url).catch(() => {
      // Não commitou: solta a trava para a próxima tentativa carregar de novo.
      if (records.get(key) === record) record.requestedUrl = null
    })
  } catch {
    record.requestedUrl = null // dom-ready seguinte restaura
  }
}

/** Recarrega a página da aba, sem recriar o elemento. */
export function reloadWebview(key: string): void {
  const record = records.get(key)
  if (!record || !record.el || !isWebviewReady(record.el)) return
  record.lastUsed = Date.now()
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
  record.lastUsed = Date.now()
  if (!record.el) return
  run(record.el, on ? SELECT_ON : SELECT_OFF)
}

/**
 * Destrói webviews desmontados e inativos. Pula:
 * - abas montadas (visíveis na UI);
 * - sessões cujo agente usou o browser recentemente (o browser em segundo
 *   plano NÃO pode morrer no meio do trabalho do agente — `agentBrowser.at`
 *   é atualizado pelo main a cada tool de browser).
 * Chamado periodicamente pelo App. Retorna quantos destruiu.
 */
export function evictInactiveWebviews(now = Date.now()): number {
  const agentBrowser = usePanelStore.getState().agentBrowser
  let removidos = 0
  for (const [key, record] of records) {
    if (record.mounted) continue
    if (now - record.lastUsed < EVICT_TTL_MS) continue
    const sId = sessionIdOf(key)
    const entry = agentBrowser[sId]
    if (entry && now - entry.at < EVICT_TTL_MS) continue
    destroyWebview(key)
    removidos++
  }
  return removidos
}

/** Destrói o webview da chave (fecho da aba) — limpa o registro no main. */
export function destroyWebview(key: string): void {
  const record = records.get(key)
  if (!record) return
  disposeElement(record)
  records.delete(key)
}
