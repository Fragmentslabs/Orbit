import { app, powerMonitor } from 'electron'

/**
 * Moments when a paired desktop's socket is probably dead or worth retrying NOW:
 * the laptop woke up, the screen unlocked, the window got focus. `onWake` is
 * throttled — focus and resume often arrive together.
 */
export function watchWake(onWake: () => void): void {
  let last = 0
  const fire = () => {
    const now = Date.now()
    if (now - last < 1000) return
    last = now
    onWake()
  }
  powerMonitor.on('resume', fire)
  powerMonitor.on('unlock-screen', fire)
  app.on('browser-window-focus', fire)
}
