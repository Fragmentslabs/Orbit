import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Icon in the system tray.
 *
 * It exists so the app can STAY ALIVE without a window: with "close to tray"
 * on, the X hides Orbit (which keeps serving the apps connected over
 * MCP) and only the tray brings it back. Without a tray, hiding would be losing the app.
 *
 * On macOS the "tray" is the MENU BAR icon (a status item) — same idea ruled by the
 * same preference. There the icon is a TEMPLATE image (black + alpha): the system
 * paints it in the menu bar's own color, so it holds up on a light bar and on a
 * dark one. The click opens the menu ("Open"/"Quit"), which is what the Mac expects
 * from an icon up there; the Dock stays as the short way back to the window.
 *
 * Theme: the menu is NATIVE, so whoever draws it follows `nativeTheme.themeSource`
 * — it is the main that adjusts it from the app's theme (channel `theme:sync`), and that is why
 * `refreshTray` is called when the theme changes. On Linux the menu is
 * drawn by the desktop environment itself and follows the SYSTEM's theme: there is no
 * way for the app to override that.
 */

export interface TrayLabels {
  /** Left click / "Open" item. */
  open: string
  /** Item that really quits the app. */
  quit: string
  /** Icon tooltip. */
  tooltip: string
}

interface TrayHandlers {
  onOpen: () => void
  onQuit: () => void
}

let tray: Tray | null = null
let currentLabels: TrayLabels | null = null

/**
 * Tray icon. The size matters: Windows asks for 16px (and scales on a HiDPI
 * screen), the macOS menu bar uses 18, and Linux's appindicator ~22 — a single
 * large PNG does not do, hence the resize.
 *
 * The order of the sources is not arbitrary: `public/tray.png` counts in BOTH worlds
 * (in dev it is public/, and in the packaged app it is dist/, which is what the builder takes
 * along). The `build/` folder only exists in dev — a tray.png there is a
 * development shortcut, it does not reach the installed app.
 *
 * macOS has its own file: `trayTemplate.png` (18px, plus the `@2x` sibling the
 * loader picks up on Retina). Template means black + alpha — the colored app icon
 * would be a dark square glued into the menu bar instead of a glyph that follows it.
 */
const inDir = (dir: string | undefined, file: string) => (dir ? path.join(dir, file) : '')

function trayIconPath(): string {
  const publicDir = process.env.VITE_PUBLIC
  const root = process.env.APP_ROOT
  const candidates =
    process.platform === 'darwin'
      ? [inDir(publicDir, 'trayTemplate.png'), inDir(root, 'build/trayTemplate.png')]
      : [
          inDir(publicDir, 'tray.png'),
          inDir(root, 'build/tray.png'),
          inDir(root, 'build/icon.png'),
          inDir(publicDir, 'logo.png'),
        ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? ''
}

function trayIcon() {
  const file = trayIconPath()
  if (!file) return nativeImage.createEmpty()
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) return image
  if (process.platform === 'darwin') {
    // Already in the menu bar's size; resizing would flatten the @2x representation
    // into a single one and blur it on Retina.
    image.setTemplateImage(true)
    return image
  }
  const size = process.platform === 'linux' ? 22 : 16
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
 * Creates the tray (idempotent). Returns null when there is no usable icon —
 * in that case the main must NOT hide the window on close, otherwise the app would be left
 * without a window and without a tray, unreachable.
 */
export function createTray(labels: TrayLabels, handlers: TrayHandlers): Tray | null {
  currentLabels = labels
  if (hasTray()) {
    refreshTray(labels, handlers)
    return tray
  }
  const icon = trayIcon()
  if (icon.isEmpty()) {
    console.warn('[tray] no usable icon in build/ or VITE_PUBLIC — no tray')
    return null
  }
  try {
    tray = new Tray(icon)
  } catch (err) {
    console.warn('[tray] could not create the tray:', err)
    tray = null
    return null
  }
  tray.setToolTip(labels.tooltip)
  // The menu is registered everywhere. On macOS it is what any click on the menu
  // bar icon opens — the way a Mac user expects to reach "Open" and "Quit"; the
  // Dock (and `activate`) is the short way back to the window, so clicking the
  // icon must not fight the menu for the same click.
  tray.setContextMenu(buildMenu(labels, handlers))
  // Windows/Linux: the click opens the window, the menu comes along. On Linux
  // some desktops (appindicator) ignore the left click — the menu stays as the
  // way to open.
  if (process.platform !== 'darwin') tray.on('click', () => handlers.onOpen())
  return tray
}

/** Reapplies labels (language change) and the menu (theme change). */
export function refreshTray(labels: TrayLabels, handlers: TrayHandlers): void {
  currentLabels = labels
  if (!hasTray()) return
  tray?.setToolTip(labels.tooltip)
  tray?.setContextMenu(buildMenu(labels, handlers))
}

/** Labels in use — for whoever needs to rebuild the menu without having them at hand. */
export function trayLabels(): TrayLabels | null {
  return currentLabels
}

export function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
}
