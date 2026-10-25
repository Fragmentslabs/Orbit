import { BrowserWindow, globalShortcut, screen, type WebContents } from 'electron'
import {
  OVERLAY_SHORTCUT,
  type OverlayContext,
  type OverlayEvent,
  type OverlaySettings,
} from '@shared/overlay'
import { getAppSettings, onAppSettingsChange } from '../app-settings'
import { readSelectedText } from './selection'

/**
 * A janela do overlay (⇧⌘espaço): desce no rodapé da tela, por cima de tudo,
 * com a persona, o campo de pergunta e a resposta curta.
 *
 * Decisões que valem registrar:
 *  - é uma janela PRÓPRIA, não a principal: a principal nasce maximizada e
 *    mostrar/esconder aquela custaria o flash de uma janela inteira. Esta é
 *    transparente, sem moldura, e fica pré-aquecida e escondida;
 *  - em modo chamada ela NÃO rouba o foco (`showInactive`): a pessoa continua
 *    no app dela, falando — e a seleção daquele app segue legível pelo AX;
 *  - a seleção é lida ANTES de mostrar (em modo texto o foco passa para cá, e
 *    depois disso o app em primeiro plano já é o Orbit).
 */

export interface OverlayHost {
  /** Preload compartilhado com as janelas do app. */
  preload: string
  /** Carrega o renderer do overlay (dev server ou arquivo). */
  load: (win: BrowserWindow) => void
}

export const OVERLAY_WIDTH = 660
const MARGIN_BOTTOM = 18
/**
 * Piso da altura: o card FECHADO (~58 pt: persona + campo) mais o vão de 8 pt
 * em cima e embaixo. É piso, não tamanho — abaixo disto o card é cortado pela
 * janela e os cantos arredondados de cima viram uma linha reta.
 */
const MIN_HEIGHT = 74
const MAX_HEIGHT = 520
/** Tempo do "tchau" antes de a janela sumir (a fala final ainda toca). */
const FAREWELL_MS = 1200

let win: BrowserWindow | null = null
let host: OverlayHost | null = null
let loading: Promise<BrowserWindow> | null = null
let height = MIN_HEIGHT
/**
 * O renderer já informou a altura real do card alguma vez? Antes disso só existe
 * o piso; depois dele, a última medida vale mais que o piso — encolher a janela
 * a cada abertura cortava o card até o próximo relatório.
 */
let measured = false
let shortcutError: string | null = null
/** Monitor escolhido na abertura: o painel não pula de tela se o cursor sair. */
let anchorDisplay: ReturnType<typeof screen.getDisplayNearestPoint> | null = null
/**
 * O renderer avisou que montou e já escuta `overlay:open`. Sem este aperto de
 * mão, o primeiro ⇧⌘espaço logo depois do boot podia mandar o contexto para uma
 * página que ainda estava montando — e o painel abria vazio, sem a seleção.
 */
let rendererReady = false
let resolveReady: (() => void) | null = null
const readyPromise = new Promise<void>((resolve) => {
  resolveReady = resolve
})
/** `before-quit`: aí o close da janela pode fechar de verdade. */
let disposing = false

export function markOverlayReady(): void {
  rendererReady = true
  resolveReady?.()
}

/** Chamado no before-quit: sem isto o `close` do painel bloquearia a saída. */
export function disposeOverlay(): void {
  disposing = true
  const target = getOverlayWindow()
  if (target && !target.isDestroyed()) target.destroy()
}
/**
 * Seleção lida na ABERTURA do painel. Em modo texto o foco passa para cá, e
 * apps que não expõem AXSelectedText não podem mais ser copiados (Cmd+C iria
 * para o Orbit) — este é o único caminho para o "traduz isso" deles.
 */
let lastSelection: { text: string; app: string | null; at: number } | null = null

export function lastOverlaySelection(): { text: string; app: string | null; at: number } | null {
  return lastSelection
}

export function setupOverlay(next: OverlayHost): void {
  host = next
}

export function getOverlayWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

function overlaySettings(): OverlaySettings {
  return getAppSettings().overlay
}

/** Monitor onde está o cursor: é sobre ele que a pessoa quer o painel. */
function targetDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

/** Mantém a borda de baixo ancorada: crescer para cima não pode empurrar o painel para fora. */
function place(nextHeight: number): void {
  const target = getOverlayWindow()
  if (!target) return
  const area = (anchorDisplay ?? targetDisplay()).workArea
  height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(nextHeight)))
  target.setBounds({
    x: Math.round(area.x + (area.width - OVERLAY_WIDTH) / 2),
    y: Math.round(area.y + area.height - height - MARGIN_BOTTOM),
    width: OVERLAY_WIDTH,
    height,
  })
}

function createWindow(): Promise<BrowserWindow> {
  const existing = getOverlayWindow()
  if (existing) return Promise.resolve(existing)
  if (loading) return loading
  if (!host) return Promise.reject(new Error('setupOverlay() não foi chamado'))

  const created = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // NADA de `vibrancy`/`backgroundMaterial`: o material nativo pinta o
    // RETÂNGULO INTEIRO da janela, e o painel (com margem para a sombra e
    // altura variável) aparecia com um segundo card de vidro atrás dele. O
    // card é um só, desenhado no CSS, e a transparência é o alpha dele.
    webPreferences: {
      preload: host.preload,
      backgroundThrottling: false,
    },
  })
  win = created

  created.setAlwaysOnTop(true, 'floating')
  created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  created.setMenuBarVisibility(false)
  // A pessoa vê o painel; a captura de tela não. É o que permite o `see_screen`
  // tirar o print com o painel na frente SEM esconder a janela — antes ela
  // sumia por um instante a cada print. Efeito colateral (bom, na maioria dos
  // casos): o painel também fica fora de prints manuais e de compartilhamento
  // de tela no Zoom/Meet.
  created.setContentProtection(true)
  created.on('closed', () => {
    if (win === created) win = null
    loading = null
  })
  // O painel não é uma janela de trabalho: fechá-lo (Cmd+W) só esconde — menos
  // na saída do app, quando a janela tem de morrer junto.
  created.on('close', (event) => {
    if (disposing || created.isDestroyed()) return
    event.preventDefault()
    hideOverlay()
  })
  created.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[overlay] processo do renderer encerrado: ${details.reason}`)
  })

  loading = new Promise<BrowserWindow>((resolve) => {
    created.webContents.once('did-finish-load', () => resolve(created))
    host!.load(created)
    // Se a página nunca terminar de carregar, a promessa não pode segurar o
    // atalho para sempre.
    setTimeout(() => resolve(created), 4000)
  })
  place(MIN_HEIGHT)
  return loading
}

/** Cria a janela escondida no boot: o primeiro ⇧⌘espaço tem que ser instantâneo. */
export function prewarmOverlay(): void {
  if (!overlaySettings().enabled) return
  void createWindow().catch(() => undefined)
}

/** A voz está pronta para o overlay abrir falando? (TTS e ditado ligados) */
function callReady(): boolean {
  const voice = getAppSettings().voice
  return voice.tts.enabled && voice.stt.enabled
}

export async function openOverlay(options?: { call?: boolean }): Promise<void> {
  const target = await createWindow().catch(() => null)
  if (!target || target.isDestroyed()) return
  // Primeira abertura: espera o renderer montar (ele avisa por overlay:ready).
  if (!rendererReady) {
    await Promise.race([readyPromise, new Promise((resolve) => setTimeout(resolve, 1500))])
  }

  anchorDisplay = targetDisplay()
  const settings = overlaySettings()
  const call = options?.call ?? (settings.openInCall && callReady())

  const context: OverlayContext = {
    call,
    // A seleção chega num segundo evento: lê-la aqui custaria dois `osascript`
    // (~200-400 ms) na frente de um atalho que precisa ser instantâneo.
    selection: null,
    selectionApp: null,
    settings,
    at: Date.now(),
  }

  // Reancora no monitor do cursor SEM encolher para o piso: janela menor que o
  // card corta o topo dele e os cantos de cima saem retos. Depois da primeira
  // medida vale a última altura; o renderer reporta a exata assim que abre e o
  // vão a mais fica transparente (a janela não tem fundo).
  place(measured ? height : MIN_HEIGHT)
  if (!target.isVisible()) {
    if (call) target.showInactive()
    else {
      target.show()
      target.focus()
    }
  }
  target.setAlwaysOnTop(true, 'floating')
  target.webContents.send('overlay:open', context)

  void readSelectedText()
    .catch(() => null)
    .then((selection) => {
      lastSelection = selection ? { text: selection.text, app: selection.app, at: Date.now() } : null
      const current = getOverlayWindow()
      if (!current || !current.isVisible()) return
      current.webContents.send('overlay:event', {
        type: 'selection',
        text: selection?.text ?? null,
        app: selection?.app ?? null,
      } satisfies OverlayEvent)
    })
}

export function hideOverlay(): void {
  const target = getOverlayWindow()
  if (!target) return
  target.webContents.send('overlay:event', { type: 'hangup', reason: 'dismissed' } satisfies OverlayEvent)
  target.hide()
}

export function toggleOverlay(options?: { call?: boolean }): void {
  const target = getOverlayWindow()
  if (target?.isVisible()) hideOverlay()
  else void openOverlay(options)
}

/** O renderer mede o conteúdo e pede a altura; a janela acompanha. */
export function resizeOverlay(nextHeight: number): void {
  if (!getOverlayWindow()) return
  measured = true
  place(nextHeight)
}

/** Eventos do chat chegam também ao overlay — ele pode ser quem fez a pergunta. */
export function forwardToOverlay(channel: string, payload: unknown): void {
  const target = getOverlayWindow()
  if (!target) return
  const contents: WebContents = target.webContents
  if (!contents.isDestroyed()) contents.send(channel, payload)
}

/**
 * A tool `end_call` vale em qualquer lugar onde exista uma conversa falada: no
 * overlay (que some) e no modo chamada da janela principal (que volta para o
 * texto). Um evento, todos os renderers escutam.
 */
export function endCallEverywhere(reason?: string): void {
  for (const other of BrowserWindow.getAllWindows()) {
    if (!other.isDestroyed()) other.webContents.send('voice:hangup', reason ?? null)
  }
  endOverlayCall(reason)
}

/**
 * O agente encerrou a conversa ("não era nada, tchau Orbit"): desliga a escuta
 * e some com o painel. O atraso deixa a despedida ser falada.
 */
export function endOverlayCall(reason?: string): void {
  const target = getOverlayWindow()
  if (!target) return
  target.webContents.send('overlay:event', { type: 'hangup', reason } satisfies OverlayEvent)
  setTimeout(() => {
    const current = getOverlayWindow()
    if (current?.isVisible()) current.hide()
  }, FAREWELL_MS)
}

/** Registra o atalho global conforme as preferências. Devolve o conflito, se houver. */
export function syncOverlayShortcut(): { ok: boolean; error?: string } {
  globalShortcut.unregister(OVERLAY_SHORTCUT)
  shortcutError = null
  if (!overlaySettings().enabled) return { ok: true }
  try {
    const registered = globalShortcut.register(OVERLAY_SHORTCUT, () => toggleOverlay())
    if (!registered) shortcutError = 'inUse'
    return registered ? { ok: true } : { ok: false, error: 'inUse' }
  } catch (err) {
    shortcutError = err instanceof Error ? err.message : String(err)
    return { ok: false, error: shortcutError }
  }
}

export function overlayShortcutStatus(): { shortcut: string; ok: boolean; error?: string } {
  const enabled = overlaySettings().enabled
  return {
    shortcut: OVERLAY_SHORTCUT,
    ok: !enabled || (!shortcutError && globalShortcut.isRegistered(OVERLAY_SHORTCUT)),
    error: shortcutError ?? undefined,
  }
}

/** Preferências mudando com o painel aberto: atalho, opacidade e persona ao vivo. */
export function watchOverlaySettings(): void {
  onAppSettingsChange((next, prev) => {
    if (next.overlay.enabled !== prev.overlay.enabled) syncOverlayShortcut()
    if (!getOverlayWindow()) return
    // Qualquer mudança no bloco vale, inclusive o MODELO: a janela é
    // pré-aquecida e não recarrega a cada abertura, então sem este repasse ela
    // seguiria com o modelo escolhido no boot.
    if (JSON.stringify(next.overlay) !== JSON.stringify(prev.overlay)) {
      forwardToOverlay('overlay:event', { type: 'settings', settings: next.overlay } satisfies OverlayEvent)
    }
  })
}
