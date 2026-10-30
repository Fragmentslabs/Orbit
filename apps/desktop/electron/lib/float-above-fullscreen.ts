import { app, type BrowserWindow } from 'electron'

/**
 * Makes the window visible in all spaces, including over apps in full
 * screen (overlay, strip and Computer Use panels).
 *
 * On macOS, `visibleOnFullScreen` turns the process into a "UIElement" app:
 * the icon disappears from the Dock and Orbit starts opening in the background, only coming back
 * with a second click. Orbit is a real Dock app, so the icon is given back
 * right after the transformation.
 */
export function floatAboveFullScreen(win: BrowserWindow): void {
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.platform === 'darwin') void app.dock?.show()
}
