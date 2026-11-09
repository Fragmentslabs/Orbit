import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { FRAGMENT_PACKAGE_EXTENSION, FRAGMENT_SHARE_CHANNELS as CH, type FragmentExportResult } from '@shared/fragment-package'
import { isFragmentId } from '@shared/fragments'
import { markReviewed } from '../fragment-provenance'
import { fragmentEvents, getFragment } from '../fragment-store'
import { buildFragmentArchive, cancelFragmentImport, confirmFragmentImport, previewFragmentImport } from './fragment-share'

/**
 * IPC of sharing. The export asks WHERE to save in a native dialog (the renderer never
 * names a path); the import is two calls, preview then confirm, and the confirmation takes
 * only the token of what the person was shown.
 */
export function registerFragmentShareIpc(): void {
  ipcMain.handle(CH.export, async (event, id: string): Promise<FragmentExportResult> => {
    if (!isFragmentId(id)) return { ok: false }
    const built = await buildFragmentArchive(id)
    if (!built) return { ok: false }
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      defaultPath: path.join(app.getPath('downloads'), built.suggestedName),
      filters: [{ name: 'Orbit fragment', extensions: [FRAGMENT_PACKAGE_EXTENSION.slice(1)] }],
    }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    await fsp.writeFile(picked.filePath, built.bytes)
    return { ok: true, path: picked.filePath }
  })

  ipcMain.handle(CH.importPreview, (_event, fileName: unknown, bytes: unknown) => previewFragmentImport(fileName, bytes))
  // The store announces the new fragment through `updated`, so the gallery re-reads on its own.
  ipcMain.handle(CH.importConfirm, (_event, token: unknown) => confirmFragmentImport(token))
  ipcMain.handle(CH.importCancel, (_event, token: unknown) => cancelFragmentImport(token))

  // The person looked at it: only their click in the details panel gets here.
  ipcMain.handle(CH.markReviewed, async (_event, id: string) => {
    if (!isFragmentId(id) || !(await getFragment(id))) return false
    const ok = await markReviewed(id)
    const manifest = await getFragment(id)
    if (ok && manifest) fragmentEvents.emit('updated', { fragmentId: id, revision: manifest.revision })
    return ok
  })
}
