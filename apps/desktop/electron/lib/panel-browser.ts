import { BrowserWindow, webContents, type NativeImage, type WebContents } from 'electron'
import sharp from 'sharp'
import {
  ConsoleBuffer,
  attachConsole,
  dragBetween,
  evaluateInPage,
  formatConsoleEntries,
  mouseMove,
  mouseUp,
  resolveTarget,
  type BrowserTarget,
} from './browser-input'

/**
 * Browser do painel direito controlado pelo agente. O renderer monta um
 * <webview> na aba Browser e registra o webContentsId aqui (panel:register);
 * as operações (navegar, ler, clicar, digitar, screenshot) rodam direto no
 * WebContents. Quando o agente precisa do browser e o painel está fechado,
 * broadcastamos "panel:event" e aguardamos o registro — o painel abre sozinho.
 *
 * O registro é POR SESSÃO de chat (Map sessionId → webContentsId): cada chat
 * tem sua própria aba/instância de browser, e as tools de um agente agem no
 * webview da SUA sessão — dois agentes em chats diferentes navegam/capturam
 * simultaneamente, cada um no seu browser, sem se atropelar.
 */

const REGISTER_TIMEOUT_MS = 10_000
const LOAD_TIMEOUT_MS = 20_000
/** Tempo máximo que um capturePage pode levar (renderer ocupado/travado). */
const CAPTURE_TIMEOUT_MS = 10_000
/** Tentativas de captura antes de desistir (o webview pode estar em repaint). */
const CAPTURE_ATTEMPTS = 3
const CAPTURE_RETRY_DELAY_MS = 500

/**
 * Falha de captura do webview do painel (vazio ou timeout). A tool
 * panel_screenshot usa o `reason` para decidir o fallback (janela oculta).
 */
export class PanelCaptureError extends Error {
  constructor(
    message: string,
    readonly reason: 'empty' | 'timeout',
  ) {
    super(message)
  }
}

const panelWcs = new Map<string, number>()

/**
 * Último viewport pedido pelo agente (panel_resize). O renderer aplica no
 * host oculto do webview; aqui serve para as capturas de FALLBACK na janela
 * oculta (captureUrl) saírem no MESMO tamanho — sem isso, um print mobile
 * viraria desktop quando o webview do painel falha. null = "preenche o
 * painel" (janela oculta usa o default 1280×800).
 */
let lastViewport: { width: number; height: number } | null = null

export function panelLastViewport(): { width: number; height: number } | null {
  return lastViewport
}

/**
 * Console de cada sessão. Vive por SESSÃO, não por webContents: o guest é
 * recriado quando a aba troca de lugar, e o histórico (o erro que derrubou a
 * página) não pode sumir junto.
 */
const consoleBySession = new Map<string, ConsoleBuffer>()
/** webContents já ligados ao console → sessão dona deles agora. */
const consoleOwners = new Map<number, string>()

function consoleOf(sessionId: string): ConsoleBuffer {
  let buffer = consoleBySession.get(sessionId)
  if (!buffer) {
    buffer = new ConsoleBuffer()
    consoleBySession.set(sessionId, buffer)
  }
  return buffer
}

/** Ponteiro com o botão ainda pressionado (panel_drag com release: false). */
const heldPointer = new Map<string, { x: number; y: number }>()

export function registerPanelWebContents(sessionId: string | null, id: number | null): void {
  if (!sessionId) return
  if (id == null) {
    panelWcs.delete(sessionId)
    return
  }
  panelWcs.set(sessionId, id)
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed()) return
  const known = consoleOwners.has(id)
  consoleOwners.set(id, sessionId)
  if (known) return
  attachConsole(wc, () => {
    const owner = consoleOwners.get(id)
    return owner ? consoleOf(owner) : undefined
  })
  wc.once('destroyed', () => consoleOwners.delete(id))
}

function getWc(sessionId: string): WebContents | null {
  const wcId = panelWcs.get(sessionId)
  if (wcId == null) return null
  const wc = webContents.fromId(wcId)
  return wc && !wc.isDestroyed() ? wc : null
}

export type PanelEvent =
  | { type: 'ensure'; url?: string; sessionId: string }
  | { type: 'resize'; width: number | null; height: number | null; label: string }
  | { type: 'fullscreen'; on: boolean }
  | { type: 'activity'; label: string; sessionId?: string }

function broadcastPanelEvent(event: PanelEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('panel:event', event)
  }
}

/**
 * Anuncia à UI o que o agente está fazendo no browser (feed de atividade).
 * `sessionId` identifica de qual chat veio — o renderer usa para manter o
 * indicador "testando…" fresco naquela sessão (badge do header e chip na
 * conversa).
 */
function activity(label: string, sessionId?: string): void {
  broadcastPanelEvent({ type: 'activity', label, sessionId })
}

/** Mesmo feed, para quem captura fora do painel (engine oculta de scripts). */
export function panelActivity(label: string): void {
  activity(label)
}

/** URL atual do browser do painel — vazia quando a sessão não tem webview. */
export function panelCurrentUrl(sessionId: string): string {
  const wc = getWc(sessionId)
  if (!wc) return ''
  const url = wc.getURL()
  return url === 'about:blank' ? '' : url
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Garante o webview da sessão registrado (criando-o no host oculto se
 * preciso) e retorna o WebContents DAQUELA sessão. `sessionId` identifica de
 * qual chat/task veio o pedido — o renderer cria o <webview> escondido e o
 * registro por sessão garante que as tools de um agente nunca agem no browser
 * de outro chat. O painel NUNCA abre sozinho: a UI só mostra o browser quando
 * o usuário clica no indicador.
 */
export async function ensurePanelBrowser(sessionId: string, url?: string): Promise<WebContents> {
  const existing = getWc(sessionId)
  if (existing) return existing
  broadcastPanelEvent({ type: 'ensure', url, sessionId })
  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  while (Date.now() < deadline) {
    const wc = getWc(sessionId)
    if (wc) return wc
    await delay(200)
  }
  throw new Error('O browser do painel não abriu a tempo (o painel direito está disponível?)')
}

async function waitForLoad(wc: WebContents): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  while (wc.isLoading() && Date.now() < deadline) await delay(150)
  await delay(400) // deixa SPAs hidratarem
}

/** Redimensiona o viewport do browser (responsividade). null = preenche o painel. */
export async function panelResize(
  sessionId: string,
  width: number | null,
  height: number | null,
  label: string,
): Promise<string> {
  await ensurePanelBrowser(sessionId)
  activity(`Redimensionando para ${label}`, sessionId)
  lastViewport = width && height ? { width, height } : null
  broadcastPanelEvent({ type: 'resize', width, height, label })
  await delay(700) // deixa o layout refluir na nova largura
  return width
    ? `Viewport ajustado para ${label} (${width}×${height}px). Use panel_screenshot para ver o resultado.`
    : `Viewport ajustado para ${label} (preenche o painel).`
}

/** Liga/desliga a tela cheia do browser do painel. */
export async function panelFullscreen(on: boolean): Promise<void> {
  broadcastPanelEvent({ type: 'fullscreen', on })
  await delay(350)
}

export async function panelNavigate(sessionId: string, url: string): Promise<{ title: string; url: string }> {
  const wc = await ensurePanelBrowser(sessionId, url)
  activity(`Navegando para ${url}`, sessionId)
  try {
    await Promise.race([wc.loadURL(url), delay(LOAD_TIMEOUT_MS)])
  } catch (err) {
    // ERR_ABORTED (-3) é comum em SPAs/redirects — não é falha real
    const code = (err as { errno?: number }).errno
    if (code !== -3) throw err
  }
  await waitForLoad(wc)
  return { title: wc.getTitle(), url: wc.getURL() }
}

/**
 * Script de leitura: marca elementos interativos visíveis com data-orbit-ref
 * e devolve título, URL, texto visível e a lista de interativos rotulados.
 */
const READ_SCRIPT = `(() => {
  const interactiveSelector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]'
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none'
  }
  const labelOf = (el) => {
    const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').trim()
    return text.replace(/\\s+/g, ' ').slice(0, 80)
  }
  let ref = 0
  const interactive = []
  for (const el of document.querySelectorAll(interactiveSelector)) {
    if (!isVisible(el)) continue
    ref += 1
    el.setAttribute('data-orbit-ref', String(ref))
    const tag = el.tagName.toLowerCase()
    const type = el.getAttribute('type')
    interactive.push('[ref=' + ref + '] <' + tag + (type ? ' type=' + type : '') + '> ' + labelOf(el))
    if (interactive.length >= 150) break
  }
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000),
    interactive,
  }
})()`

export async function panelRead(sessionId: string): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  activity('Lendo a página', sessionId)
  const result = (await wc.executeJavaScript(READ_SCRIPT)) as {
    title: string
    url: string
    text: string
    interactive: string[]
  }
  return [
    `Página: ${result.title} — ${result.url}`,
    '',
    '## Conteúdo visível',
    result.text || '(página vazia)',
    '',
    `## Elementos interativos (use ref em panel_click/panel_type)`,
    result.interactive.join('\n') || '(nenhum encontrado)',
  ].join('\n')
}

function findScript(ref?: number, selector?: string): string {
  if (ref != null) return `document.querySelector('[data-orbit-ref="${ref}"]')`
  return `document.querySelector(${JSON.stringify(selector ?? '')})`
}

export async function panelClick(sessionId: string, ref?: number, selector?: string): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  activity(`Clicando em ${ref != null ? `ref ${ref}` : selector}`, sessionId)
  const outcome = (await wc.executeJavaScript(`(() => {
    const el = ${findScript(ref, selector)}
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    el.click()
    return true
  })()`)) as boolean | null
  if (!outcome) return `Elemento não encontrado (${ref != null ? `ref=${ref}` : selector}). Rode panel_read para atualizar as refs.`
  await waitForLoad(wc)
  return `Clique executado. Agora em: ${wc.getTitle()} — ${wc.getURL()}`
}

export async function panelType(
  sessionId: string,
  text: string,
  ref?: number,
  selector?: string,
  pressEnter?: boolean,
): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  activity('Digitando…', sessionId)
  const outcome = (await wc.executeJavaScript(`(() => {
    const el = ${findScript(ref, selector)}
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    el.focus()
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, ${JSON.stringify(text)})
    else el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    if (${pressEnter === true}) {
      const form = el.form
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    }
    return true
  })()`)) as boolean | null
  if (!outcome) return `Campo não encontrado (${ref != null ? `ref=${ref}` : selector}). Rode panel_read para atualizar as refs.`
  await waitForLoad(wc)
  return `Texto digitado${pressEnter ? ' e enviado' : ''}. Agora em: ${wc.getTitle()} — ${wc.getURL()}`
}

/**
 * Screenshot do viewport, reduzido para ≤1024px de largura por padrão
 * (economia de tokens — `maxWidth` sobe isso para documentação). Com
 * fullscreen, entra em tela cheia para capturar a tela toda e volta à visão
 * lateral logo depois (o print sai maior e a UI retorna ao normal).
 *
 * Para a PÁGINA INTEIRA (além do viewport) o caminho é outro: captureUrl em
 * browser-script.ts, numa janela oculta — redimensionar o webview visível
 * faria a UI piscar.
 */
export async function panelScreenshot(
  sessionId: string,
  fullscreen = false,
  options?: { format?: 'webp' | 'png'; maxWidth?: number },
): Promise<Buffer> {
  const wc = await ensurePanelBrowser(sessionId)
  activity('Capturando a tela', sessionId)

  /**
   * Captura com proteções: o capturePage do webview oculto do painel devolve
   * imagem VAZIA quando o webview não está pintado (host oculto, 0×0 após
   * resize) e pode nunca resolver quando o renderer está ocupado — os dois
   * casos viravam "Input buffer is empty" do sharp ou travavam a tool.
   */
  const capture = async (defaultWidth: number) => {
    const maxWidth = options?.maxWidth ?? defaultWidth
    const CAPTURE_TIMED_OUT = Symbol('captureTimedOut')
    let timedOut = false
    for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt += 1) {
      const outcome = await Promise.race<NativeImage | typeof CAPTURE_TIMED_OUT>([
        wc.capturePage(),
        delay(CAPTURE_TIMEOUT_MS).then(() => CAPTURE_TIMED_OUT),
      ])
      if (outcome !== CAPTURE_TIMED_OUT) {
        const png = outcome.toPNG()
        if (!outcome.isEmpty() && png.length > 0) {
          const { width } = outcome.getSize()
          const resized = width > maxWidth ? outcome.resize({ width: maxWidth }) : outcome
          const pipeline = sharp(resized.toPNG())
          return options?.format === 'png'
            ? await pipeline.png().toBuffer()
            : await pipeline.webp({ quality: 80 }).toBuffer()
        }
      } else {
        timedOut = true
      }
      if (attempt < CAPTURE_ATTEMPTS) await delay(CAPTURE_RETRY_DELAY_MS)
    }
    throw new PanelCaptureError(
      timedOut
        ? 'O webview do painel não respondeu à captura a tempo — o browser pode estar ocupado ou travado; tente de novo (ou panel_navigate) e, se persistir, abra o painel.'
        : 'O webview do painel está oculto ou sem pintura (captura vazia) — o browser precisa estar visível; tente panel_resize desktop ou abra o painel e capture de novo.',
      timedOut ? 'timeout' : 'empty',
    )
  }

  if (!fullscreen) return capture(1024)
  await panelFullscreen(true)
  try {
    await delay(300)
    return capture(1440)
  } finally {
    await panelFullscreen(false)
  }
}

/** Mensagens do console da página do painel (erros, warnings, logs). */
export function panelConsole(
  sessionId: string,
  options: { level?: 'all' | 'warning' | 'error'; pattern?: string; limit?: number; clear?: boolean },
): string {
  const buffer = consoleBySession.get(sessionId)
  if (!buffer || buffer.size === 0) {
    return getWc(sessionId)
      ? 'Console vazio — nenhuma mensagem desde que o browser abriu.'
      : 'O browser desta sessão ainda não abriu — use panel_navigate antes.'
  }
  const entries = buffer.query(options)
  if (options.clear) buffer.clear()
  const filtro = options.level && options.level !== 'all' ? ` (nível ${options.level}+)` : ''
  if (entries.length === 0) return `Nenhuma mensagem${filtro}${options.pattern ? ` contendo "${options.pattern}"` : ''}.`
  return `${entries.length} mensagem(ns)${filtro}${options.clear ? ' — console limpo em seguida' : ''}:\n${formatConsoleEntries(entries)}`
}

/** Roda JS na página do painel (a mesma que o usuário vê) e devolve o resultado. */
export async function panelEval(sessionId: string, code: string): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  activity('Executando JavaScript na página', sessionId)
  return evaluateInPage(wc, code)
}

/** Passa o mouse sobre um elemento (menus, tooltips, estados :hover). */
export async function panelHover(sessionId: string, target: BrowserTarget): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  const point = await resolveTarget(wc, target, true)
  if (typeof point === 'string') return point
  activity('Passando o mouse', sessionId)
  mouseMove(wc, point, heldPointer.has(sessionId))
  await delay(300)
  return `Mouse sobre (${Math.round(point.x)}, ${Math.round(point.y)}). Use panel_screenshot para ver o estado de hover.`
}

/**
 * Arrasta com eventos de mouse reais. Com release: false o botão continua
 * pressionado — o agente tira o print do meio do gesto e chama de novo (sem
 * from) para continuar ou soltar.
 */
export async function panelDrag(
  sessionId: string,
  options: { from?: BrowserTarget; to: BrowserTarget; steps?: number; release?: boolean },
): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  const held = heldPointer.get(sessionId) ?? null
  if (options.from && held) {
    // Um arrasto pendente com o botão pressionado: solta antes de começar outro
    mouseUp(wc, held)
    heldPointer.delete(sessionId)
    await delay(150)
  }
  if (!options.from && !held) return 'Nenhum arrasto em andamento — informe from (ref, selector ou x/y).'
  const from = options.from ? await resolveTarget(wc, options.from, true) : null
  if (typeof from === 'string') return from
  const to = await resolveTarget(wc, options.to, false)
  if (typeof to === 'string') return to
  activity(options.release === false ? 'Arrastando (segurando)' : 'Arrastando', sessionId)
  const end = await dragBetween(wc, from, to, {
    held: options.from ? null : held,
    steps: options.steps,
    release: options.release,
  })
  if (options.release === false) {
    heldPointer.set(sessionId, end)
    return `Arrastando — botão ainda pressionado em (${Math.round(end.x)}, ${Math.round(end.y)}). Tire o panel_screenshot agora; depois chame panel_drag sem from para mover mais ou soltar (release: true).`
  }
  heldPointer.delete(sessionId)
  return `Solto em (${Math.round(end.x)}, ${Math.round(end.y)}). Agora em: ${wc.getTitle()} — ${wc.getURL()}`
}
