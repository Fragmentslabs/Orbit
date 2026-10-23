import { BrowserWindow, globalShortcut, screen } from 'electron'
import type { ComputerActivity, ComputerEvent } from '@shared/computer'
import { tNow } from '../i18n'
import { disposeComputerPanels, setComputerPanelsSession } from './panels'

/**
 * Estado vivo do controle do computador: quem está controlando o quê, o
 * indicador sempre visível, o atalho de pânico e a devolução das flags de
 * acessibilidade ligadas nos apps. Tudo isto nasce com a primeira ação e
 * morre com o fim do turno (ou o Parar) — o atalho global não fica preso à toa.
 */

/**
 * Rede de segurança: sem nenhuma ação por este tempo, o controle é dado como
 * encerrado mesmo sem o fim do turno. Não é o fim normal — esse é o fim do
 * turno (chat-engine) ou o Parar. Com 20 s, o agente pensando entre uma ação e
 * outra perdia a faixa e o atalho de pânico no meio do turno, e o ⌘⇧. não
 * parava nada (relatado no teste no app).
 */
const IDLE_MS = 5 * 60_000
/** ⌘⇧. é o anunciado na faixa; ⌘⇧Esc é a reserva, para quem procura "Esc". */
export const PANIC_SHORTCUTS = ['CommandOrControl+Shift+.', 'CommandOrControl+Shift+Escape']

interface Live {
  activity: ComputerActivity
  timer: NodeJS.Timeout
}

const live = new Map<string, Live>()
/** pid → sessões que ligaram a flag de acessibilidade nele */
const enhanced = new Map<number, Set<string>>()

let overlay: BrowserWindow | null = null
let overlayText: string | null = null
let shortcutOn = false
let stopHandler: ((sessionId: string) => void) | null = null
let restoreHandler: ((pids: number[]) => Promise<void>) | null = null

/** Quem para o turno (abortSession) — injetado pelo main para não criar ciclo de import. */
export function setComputerStopHandler(handler: (sessionId: string) => void): void {
  stopHandler = handler
}

export function setComputerRestoreHandler(handler: (pids: number[]) => Promise<void>): void {
  restoreHandler = handler
}

// Vai também para a janela dos painéis (ela mostra o app sendo controlado).
function broadcast(event: ComputerEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== overlay && !win.isDestroyed()) win.webContents.send('computer:event', event)
  }
}

export function getComputerActivity(): ComputerActivity[] {
  return [...live.values()].map((l) => l.activity)
}

/** O app já está com a flag de acessibilidade ligada (por qualquer sessão)? */
export function isEnhanced(pid: number): boolean {
  return enhanced.has(pid)
}

export function noteEnhanced(sessionId: string, pid: number): void {
  const set = enhanced.get(pid) ?? new Set<string>()
  set.add(sessionId)
  enhanced.set(pid, set)
}

/** Registra atividade: liga indicador e atalho na primeira, renova o prazo nas seguintes. */
export function noteActivity(sessionId: string, app: string, action: string | null): void {
  const now = Date.now()
  const current = live.get(sessionId)
  if (current) clearTimeout(current.timer)
  const activity: ComputerActivity = {
    sessionId,
    app,
    startedAt: current?.activity.startedAt ?? now,
    lastAt: now,
    lastAction: action ?? current?.activity.lastAction ?? null,
  }
  live.set(sessionId, { activity, timer: setTimeout(() => endActivity(sessionId), IDLE_MS) })
  ensureShortcut()
  showOverlay()
  setComputerPanelsSession(sessionId)
  broadcast({ type: 'active', activity })
}

/** Encerra o controle de uma sessão (ocioso, Parar ou fim do turno). */
export function endActivity(sessionId: string): void {
  const current = live.get(sessionId)
  if (current) clearTimeout(current.timer)
  live.delete(sessionId)
  const pids: number[] = []
  for (const [pid, sessions] of enhanced) {
    sessions.delete(sessionId)
    if (sessions.size === 0) {
      enhanced.delete(pid)
      pids.push(pid)
    }
  }
  if (pids.length && restoreHandler) void restoreHandler(pids)
  if (current) broadcast({ type: 'idle', sessionId })
  if (live.size === 0) {
    releaseShortcut()
    hideOverlay()
    setComputerPanelsSession(null)
  } else {
    showOverlay()
    // Os painéis seguem a sessão que agiu por último entre as que restam.
    const latest = [...live.values()].sort((a, b) => b.activity.lastAt - a.activity.lastAt)[0]
    setComputerPanelsSession(latest.activity.sessionId)
  }
}

/** Parar: aborta o turno (o abort mata a bridge em andamento) e encerra o controle. */
export function stopComputer(sessionId?: string): void {
  const targets = sessionId ? [sessionId] : [...live.keys()]
  for (const id of targets) {
    stopHandler?.(id)
    endActivity(id)
  }
}

function ensureShortcut(): void {
  if (shortcutOn) return
  for (const accelerator of PANIC_SHORTCUTS) {
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, () => stopComputer())
    } catch {
      ok = false
    }
    // Outro app pode já ter o atalho: sem log, o pânico falharia em silêncio.
    if (!ok) console.warn(`[computer] atalho de parar não registrado: ${accelerator}`)
    shortcutOn = shortcutOn || ok
  }
}

function releaseShortcut(): void {
  if (!shortcutOn) return
  for (const accelerator of PANIC_SHORTCUTS) globalShortcut.unregister(accelerator)
  shortcutOn = false
}

function overlayHtml(text: string): string {
  const safe = text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)
  // Amarelo primário do Orbit (--primary do tema escuro). A janela é mais alta
  // do que a faixa para caber o anel e a sombra, e o body ocupa a janela toda:
  // com a altura do conteúdo, o overflow:hidden dele cortava o anel numa linha
  // reta rente à base da faixa.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:600 12px -apple-system,system-ui,sans-serif}
body{padding-top:8px;box-sizing:border-box}
.bar{margin:0 auto;width:max-content;max-width:96vw;display:flex;gap:8px;align-items:center;padding:6px 14px;border-radius:999px;
background:rgba(16,16,20,.86);color:#fff;box-shadow:0 0 0 2px oklch(0.795 0.184 86.047),0 4px 12px rgba(0,0,0,.3)}
.dot{width:8px;height:8px;border-radius:50%;background:oklch(0.852 0.199 91.936);animation:p 1.2s ease-in-out infinite}
@keyframes p{50%{opacity:.35}}
</style></head><body><div class="bar"><span class="dot"></span><span>${safe}</span></div></body></html>`
}

/**
 * Faixa no topo da tela enquanto o agente controla o computador. Atravessável
 * pelo mouse e sem foco: ela não pode virar alvo de clique nem roubar teclado
 * do app que o agente está usando. Também nunca aparece no screenshot — a
 * captura é da janela alvo, não da tela.
 */
function showOverlay(): void {
  const apps = [...new Set([...live.values()].map((l) => l.activity.app))].join(', ')
  const text = tNow('computer.overlay', { apps })
  if (!overlay || overlay.isDestroyed()) {
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(640, area.width)
    overlay = new BrowserWindow({
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y,
      width,
      height: 64,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setIgnoreMouseEvents(true)
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    overlay.on('closed', () => {
      overlay = null
      overlayText = null
    })
  }
  // Recarregar a cada ação faria a faixa piscar: só quando o texto muda.
  if (text === overlayText) return
  overlayText = text
  void overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(text))}`).then(() => {
    if (overlay && !overlay.isDestroyed() && !overlay.isVisible()) overlay.showInactive()
  })
}

function hideOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.destroy()
  overlay = null
  overlayText = null
}

/** Encerramento do app: devolve as flags, solta o atalho e fecha o indicador. */
export async function disposeComputerSessions(): Promise<void> {
  for (const l of live.values()) clearTimeout(l.timer)
  live.clear()
  const pids = [...enhanced.keys()]
  enhanced.clear()
  releaseShortcut()
  hideOverlay()
  disposeComputerPanels()
  if (pids.length && restoreHandler) await restoreHandler(pids)
}
