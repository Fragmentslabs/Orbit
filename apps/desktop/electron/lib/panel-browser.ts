import { BrowserWindow, webContents, type WebContents } from 'electron'
import sharp from 'sharp'

/**
 * Browser do painel direito controlado pelo agente. O renderer monta um
 * <webview> na aba Browser e registra o webContentsId aqui (panel:register);
 * as operações (navegar, ler, clicar, digitar, screenshot) rodam direto no
 * WebContents. Quando o agente precisa do browser e o painel está fechado,
 * broadcastamos "panel:event" e aguardamos o registro — o painel abre sozinho.
 */

const REGISTER_TIMEOUT_MS = 10_000
const LOAD_TIMEOUT_MS = 20_000

let panelWcId: number | null = null

export function registerPanelWebContents(id: number | null): void {
  panelWcId = id
}

function getWc(): WebContents | null {
  if (panelWcId == null) return null
  const wc = webContents.fromId(panelWcId)
  return wc && !wc.isDestroyed() ? wc : null
}

export type PanelEvent =
  | { type: 'open'; url?: string }
  | { type: 'resize'; width: number | null; height: number | null; label: string }
  | { type: 'fullscreen'; on: boolean }
  | { type: 'activity'; label: string }

function broadcastPanelEvent(event: PanelEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('panel:event', event)
  }
}

/** Anuncia à UI o que o agente está fazendo no browser (feed de atividade). */
function activity(label: string): void {
  broadcastPanelEvent({ type: 'activity', label })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Garante o webview montado (abre o painel se preciso) e retorna o WebContents. */
export async function ensurePanelBrowser(url?: string): Promise<WebContents> {
  const existing = getWc()
  if (existing) return existing
  broadcastPanelEvent({ type: 'open', url })
  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  while (Date.now() < deadline) {
    const wc = getWc()
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
  width: number | null,
  height: number | null,
  label: string,
): Promise<string> {
  await ensurePanelBrowser()
  activity(`Redimensionando para ${label}`)
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

export async function panelNavigate(url: string): Promise<{ title: string; url: string }> {
  const wc = await ensurePanelBrowser(url)
  activity(`Navegando para ${url}`)
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

export async function panelRead(): Promise<string> {
  const wc = await ensurePanelBrowser()
  activity('Lendo a página')
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

export async function panelClick(ref?: number, selector?: string): Promise<string> {
  const wc = await ensurePanelBrowser()
  activity(`Clicando em ${ref != null ? `ref ${ref}` : selector}`)
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
  text: string,
  ref?: number,
  selector?: string,
  pressEnter?: boolean,
): Promise<string> {
  const wc = await ensurePanelBrowser()
  activity('Digitando…')
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
 * Screenshot do viewport, reduzido para ≤1024px de largura (economia de tokens).
 * Com fullscreen, entra em tela cheia para capturar a tela toda e volta à visão
 * lateral logo depois (o print sai maior e a UI retorna ao normal).
 */
export async function panelScreenshot(fullscreen = false): Promise<Buffer> {
  const wc = await ensurePanelBrowser()
  activity('Capturando a tela')
  const capture = async (maxWidth: number) => {
    const image = await wc.capturePage()
    const { width } = image.getSize()
    const resized = width > maxWidth ? image.resize({ width: maxWidth }) : image
    return await sharp(resized.toPNG()).webp({ quality: 80 }).toBuffer()
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
