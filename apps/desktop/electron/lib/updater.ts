import { app, BrowserWindow, dialog } from 'electron'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

type ElectronUpdater = typeof import('electron-updater')

let started = false

/**
 * Auto-update via GitHub Releases (electron-updater): AppImage on Linux,
 * signed+notarized ZIP on macOS, NSIS installer on Windows.
 *
 * It never runs in the store variants (Mac App Store / Microsoft Store): the
 * update there is the store's responsibility, and the sandbox would block the
 * download anyway. On Linux, only AppImage supports automatic update
 * (deb is a manual update).
 */
export function setupAutoUpdater(opts?: { onBeforeInstallQuit?: () => void }) {
  if (!app.isPackaged) return
  if (process.mas || process.windowsStore) return
  if (process.platform === 'linux' && !process.env.APPIMAGE) return
  if (started) return
  started = true

  // CJS at runtime (same pattern as node-pty/jszip in the main)
  const { autoUpdater } = _require('electron-updater') as ElectronUpdater

  autoUpdater.autoDownload = true
  // If the user chose "Later", it installs silently on the next quit
  autoUpdater.autoInstallOnAppQuit = true

  // Never bring the app down because of the updater: network failure/offline is normal
  autoUpdater.on('error', (err) => {
    console.warn('[updater] failed to check for an update:', (err as Error)?.message ?? err)
  })

  autoUpdater.on('update-downloaded', (info) => {
    const [win] = BrowserWindow.getAllWindows()
    const options = {
      type: 'info' as const,
      title: 'Update available',
      message: `Orbit ${info.version} has been downloaded.`,
      detail: 'Restart now to install the new version?',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }
    const show = async () => {
      const { response } = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      if (response === 0) {
        // Installing means leaving for real: the app is resident on macOS, and
        // without this mark the `before-quit` would only close the window and the
        // update would never install.
        opts?.onBeforeInstallQuit?.()
        // Leaves the current stack before restarting: avoids hanging the quit
        setImmediate(() => autoUpdater.quitAndInstall())
      }
    }
    void show()
  })

  // Delayed: it does not compete with startup nor with the entrance sound
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      console.warn('[updater] update check failed:', (err as Error)?.message ?? err)
    })
  }, 10_000)
}