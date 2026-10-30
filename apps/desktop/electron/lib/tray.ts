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
 * Only Windows and Linux have it: on macOS the X closes the window and the app stays alive
 * in the Dock, which is already the way back — the main does not even create it there. The
 * `darwin` branches below stay as what it would need to come back to the Mac.
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
  if (process.platform === 'darwin') {
    // On macOS setContextMenu hijacks the left click (the menu would open on
    // any click); for "left opens, right shows options" the menu is
    // raised by hand, on the right button.
    tray.on('click', () => handlers.onOpen())
    tray.on('right-click', () => tray?.popUpContextMenu(buildMenu(labels, handlers)))
  } else {
    // Windows/Linux: the right-button menu is registered at once. On
    // Linux some desktops (appindicator) ignore the left click — the menu
    // remains the way to open.
    tray.setContextMenu(buildMenu(labels, handlers))
    tray.on('click', () => handlers.onOpen())
  }
  return tray
}

/** Reapplies labels (language change) and the menu (theme change). */
export function refreshTray(labels: TrayLabels, handlers: TrayHandlers): void {
  currentLabels = labels
  if (!hasTray()) return
  tray?.setToolTip(labels.tooltip)
  if (process.platform !== 'darwin') tray?.setContextMenu(buildMenu(labels, handlers))
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
