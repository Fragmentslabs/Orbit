import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Ícone na bandeja do sistema.
 *
 * Existe para o app poder FICAR VIVO sem janela: com "fechar para a bandeja"
 * ligado, o X esconde o Orbit (que continua servindo os apps conectados por
 * MCP) e só a bandeja o traz de volta. Sem bandeja, esconder seria perder o app.
 *
 * Tema: o menu é NATIVO, então quem o desenha segue o `nativeTheme.themeSource`
 * — é o main que o ajusta a partir do tema do app (canal `theme:sync`), e é por
 * isso que `refreshTray` é chamado quando o tema troca. No Linux o menu é
 * desenhado pelo próprio desktop environment e segue o tema DO SISTEMA: não há
 * como o app sobrepor isso.
 */

export interface TrayLabels {
  /** Clique esquerdo / item "Abrir". */
  open: string
  /** Item que encerra o app de verdade. */
  quit: string
  /** Tooltip do ícone. */
  tooltip: string
}

interface TrayHandlers {
  onOpen: () => void
  onQuit: () => void
}

let tray: Tray | null = null
let currentLabels: TrayLabels | null = null

/**
 * Ícone da bandeja. O tamanho importa: o Windows pede 16px (e escala em tela
 * HiDPI), o menu bar do macOS usa 18, e o appindicator do Linux ~22 — um único
 * PNG grande não serve, daí o resize.
 *
 * A ordem das fontes não é arbitrária: `public/tray.png` vale nos DOIS mundos
 * (em dev é public/, e no app empacotado é dist/, que é o que o builder leva
 * junto). A pasta `build/` só existe em dev — um tray.png lá é atalho de
 * desenvolvimento, não chega no app instalado.
 */
function trayIconPath(): string {
  const candidates = [
    path.join(process.env.VITE_PUBLIC ?? '', 'tray.png'),
    path.join(process.env.APP_ROOT ?? '', 'build', 'tray.png'),
    path.join(process.env.APP_ROOT ?? '', 'build', 'icon.png'),
    path.join(process.env.VITE_PUBLIC ?? '', 'logo.png'),
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? ''
}

function trayIcon() {
  const file = trayIconPath()
  if (!file) return nativeImage.createEmpty()
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) return image
  const size = process.platform === 'darwin' ? 18 : process.platform === 'linux' ? 22 : 16
  return image.resize({ width: size, height: size, quality: 'best' })
}

function buildMenu(labels: TrayLabels, handlers: TrayHandlers): Menu {
  const template: MenuItemConstructorOptions[] = [
    { label: labels.open, click: () => handlers.onOpen() },
    { type: 'separator' },
    { label: labels.quit, click: () => handlers.onQuit() },
  ]
  return Menu.buildFromTemplate(template)
}

export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed()
}

/**
 * Cria a bandeja (idempotente). Devolve null quando não há ícone utilizável —
 * nesse caso o main NÃO deve esconder a janela no fechar, senão o app ficaria
 * sem janela e sem bandeja, inalcançável.
 */
export function createTray(labels: TrayLabels, handlers: TrayHandlers): Tray | null {
  currentLabels = labels
  if (hasTray()) {
    refreshTray(labels, handlers)
    return tray
  }
  const icon = trayIcon()
  if (icon.isEmpty()) {
    console.warn('[tray] nenhum ícone utilizável em build/ ou no VITE_PUBLIC — sem bandeja')
    return null
  }
  try {
    tray = new Tray(icon)
  } catch (err) {
    console.warn('[tray] não foi possível criar a bandeja:', err)
    tray = null
    return null
  }
  tray.setToolTip(labels.tooltip)
  if (process.platform === 'darwin') {
    // No macOS o setContextMenu sequestra o clique esquerdo (o menu abriria em
    // qualquer clique); para "esquerdo abre, direito mostra opções" o menu é
    // levantado na mão, no botão direito.
    tray.on('click', () => handlers.onOpen())
    tray.on('right-click', () => tray?.popUpContextMenu(buildMenu(labels, handlers)))
  } else {
    // Windows/Linux: o menu do botão direito é registrado de uma vez. No
    // Linux alguns desktops (appindicator) ignoram o clique esquerdo — o menu
    // continua sendo o caminho para abrir.
    tray.setContextMenu(buildMenu(labels, handlers))
    tray.on('click', () => handlers.onOpen())
  }
  return tray
}

/** Reaplica rótulos (troca de idioma) e o menu (troca de tema). */
export function refreshTray(labels: TrayLabels, handlers: TrayHandlers): void {
  currentLabels = labels
  if (!hasTray()) return
  tray?.setToolTip(labels.tooltip)
  if (process.platform !== 'darwin') tray?.setContextMenu(buildMenu(labels, handlers))
}

/** Rótulos em uso — para quem precisa reconstruir o menu sem os ter à mão. */
export function trayLabels(): TrayLabels | null {
  return currentLabels
}

export function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
}
