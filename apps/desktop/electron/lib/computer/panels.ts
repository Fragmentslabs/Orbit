import { app, BrowserWindow, ipcMain, screen } from 'electron'

/**
 * Painéis flutuantes do Computer Use: enquanto o agente controla outro app e
 * o Orbit está fora de foco, a conversa fica na borda esquerda da tela e as
 * ações do agente na direita — o mesmo desenho da tela cheia do navegador
 * (alça recolhida que abre no hover).
 *
 * É uma janela transparente do tamanho da área útil da tela, acima das outras
 * e atravessável pelo mouse: só os painéis capturam clique (o renderer avisa
 * quando o mouse entra/sai deles). Nunca recebe foco — o teclado continua com
 * o app que o agente está usando — e nunca sai no screenshot, que é da janela
 * alvo, não da tela.
 */

export interface PanelsLoader {
  preload: string
  /** Carrega o renderer da janela (dev server ou arquivo), com a query */
  load: (win: BrowserWindow, query: Record<string, string>) => void
}

let loader: PanelsLoader | null = null
let win: BrowserWindow | null = null
let sessionId: string | null = null
let focusCheck: NodeJS.Timeout | null = null
/** Mouse sobre um painel agora */
let interactive = false

/** O main injeta como carregar o renderer (o mesmo preload e o mesmo bundle das janelas do app). */
export function setupComputerPanels(next: PanelsLoader): void {
  loader = next
  ipcMain.on('computer-panels:interactive', (event, over: boolean) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    interactive = over
    win.setIgnoreMouseEvents(!over, { forward: true })
    // Saiu do painel: se o Orbit ganhou foco enquanto isso, agora esconde.
    if (!over) refresh()
  })
  // Foco entre janelas do Orbit: o blur chega antes do focus da próxima, então
  // a decisão espera um instante para não piscar ao trocar de janela.
  app.on('browser-window-focus', () => refresh())
  app.on('browser-window-blur', () => {
    if (focusCheck) clearTimeout(focusCheck)
    focusCheck = setTimeout(refresh, 80)
  })
}

export function isComputerPanelsWindow(target: BrowserWindow | null): boolean {
  return Boolean(target && win && target === win)
}

function orbitFocused(): boolean {
  const focused = BrowserWindow.getFocusedWindow()
  return Boolean(focused && focused !== win)
}

/** Sessão controlando agora (null = ninguém): mostra ou esconde conforme o foco. */
export function setComputerPanelsSession(next: string | null): void {
  sessionId = next
  refresh()
}

function refresh(): void {
  // Com o mouse sobre um painel, não some: se o clique ainda assim ativar o
  // Orbit, o painel não pode desaparecer embaixo do cursor.
  if (sessionId && interactive && win && !win.isDestroyed() && win.isVisible()) return
  if (!sessionId || orbitFocused() || !loader) {
    hide()
    return
  }
  show(sessionId)
}

function show(id: string): void {
  if (!loader) return
  if (win && !win.isDestroyed()) {
    win.webContents.send('computer-panels:session', id)
    if (!win.isVisible()) win.showInactive()
    return
  }
  const area = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    ...area,
    // NSPanel não ativador: clicar no pin ou num card não traz o Orbit para a
    // frente. Janela comum ativava o app no clique — o Orbit ganhava foco e os
    // painéis sumiam no mesmo instante (relatado no primeiro teste).
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: loader.preload, backgroundThrottling: false },
  })
  // Abaixo da faixa "Orbit está controlando" (screen-saver), acima dos apps.
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed() && sessionId) win.showInactive()
  })
  win.on('closed', () => {
    win = null
    interactive = false
  })
  loader.load(win, { session: id })
}

function hide(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide()
}

export function disposeComputerPanels(): void {
  sessionId = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}
