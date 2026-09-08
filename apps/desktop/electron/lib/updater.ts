import { app, BrowserWindow, dialog } from 'electron'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

type ElectronUpdater = typeof import('electron-updater')

let started = false

/**
 * Auto-update via GitHub Releases (electron-updater): AppImage no Linux,
 * ZIP assinado+notarizado no macOS, instalador NSIS no Windows.
 *
 * Nunca roda nas variantes de loja (Mac App Store / Microsoft Store): a
 * atualização ali é de responsabilidade da loja, e o sandbox bloquearia o
 * download de qualquer forma. No Linux, apenas AppImage suporta update
 * automático (deb é atualização manual).
 */
export function setupAutoUpdater() {
  if (!app.isPackaged) return
  if (process.mas || process.windowsStore) return
  if (process.platform === 'linux' && !process.env.APPIMAGE) return
  if (started) return
  started = true

  // CJS no runtime (mesmo padrão do node-pty/jszip no main)
  const { autoUpdater } = _require('electron-updater') as ElectronUpdater

  autoUpdater.autoDownload = true
  // Se o usuário escolheu "Depois", instala silenciosamente no próximo quit
  autoUpdater.autoInstallOnAppQuit = true

  // Nunca derrubar o app por causa do updater: falha de rede/offline é normal
  autoUpdater.on('error', (err) => {
    console.warn('[updater] erro ao verificar atualização:', (err as Error)?.message ?? err)
  })

  autoUpdater.on('update-downloaded', (info) => {
    const [win] = BrowserWindow.getAllWindows()
    const options = {
      type: 'info' as const,
      title: 'Atualização disponível',
      message: `Orbit ${info.version} foi baixado.`,
      detail: 'Reiniciar agora para instalar a nova versão?',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
    }
    const show = async () => {
      const { response } = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      if (response === 0) {
        // Sai da pilha atual antes de reiniciar: evita travar o quit
        setImmediate(() => autoUpdater.quitAndInstall())
      }
    }
    void show()
  })

  // Atrasada: não compete com a inicialização nem com o som de entrada
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      console.warn('[updater] verificação de atualização falhou:', (err as Error)?.message ?? err)
    })
  }, 10_000)
}