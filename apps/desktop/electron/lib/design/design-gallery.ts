import { DESIGN_SCHEME } from '@shared/media'
import { BrowserWindow } from 'electron'
import path from 'node:path'
import sharp from 'sharp'
import { saveDesignMedia, setMediaDeleteHook } from '../media'
import { readDesignCanvas } from './design-canvas'
import { deleteDesignCanvas, getDesign } from './design-store'

/**
 * A CAPA de um canvas de design, e o registro dele na galeria — espelha
 * video/motion-gallery.ts. A miniatura é o PRIMEIRO artboard (`order[0]`),
 * fotografado numa janela offscreen no próprio tamanho dele; sem seek nem
 * medição de camada, porque o artboard é estático.
 */

const COVER_WIDTH = 640
const LOAD_TIMEOUT_MS = 15_000

interface CoverShot {
  png: Buffer
  width: number
  height: number
}

async function captureCover(id: string, folder: string): Promise<CoverShot | null> {
  const canvas = await readDesignCanvas(folder).catch(() => null)
  if (!canvas || canvas.order.length === 0) return null
  const file = canvas.order[0]
  const board = canvas.boards[file]
  if (!board) return null
  const width = Math.max(40, Math.round(board.w))
  const height = Math.max(40, Math.round(board.h))
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    frame: false,
    useContentSize: true,
    // Sem isto o Chromium não pinta uma janela nunca exibida.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const timer = setTimeout(() => {
    if (!win.isDestroyed()) win.destroy()
  }, LOAD_TIMEOUT_MS)
  try {
    const url = `${DESIGN_SCHEME}://${id}/${file.split('/').map(encodeURIComponent).join('/')}`
    await Promise.race([win.loadURL(url).catch(() => {}), new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS))])
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true).catch(() => {})
    // Um instante para o Chromium terminar de pintar.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    if (png.length === 0) return null
    const buffer = await sharp(png).resize({ width: COVER_WIDTH, withoutEnlargement: true }).png().toBuffer()
    return { png: buffer, width, height }
  } finally {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * Põe (ou atualiza) o canvas na galeria, com a capa tirada agora. Idempotente:
 * registrar o mesmo canvas de novo cai no MESMO item — é o `designId` que
 * manda, não o momento.
 */
export async function registerDesignCover(id: string, opts: { title?: string; sessionId?: string } = {}): Promise<boolean> {
  const entry = await getDesign(id)
  if (!entry) return false
  const shot = await captureCover(id, entry.folder).catch(() => null)
  await saveDesignMedia(shot?.png ?? null, {
    designId: id,
    title: opts.title ?? path.basename(entry.folder),
    directory: entry.root,
    sessionId: opts.sessionId ?? entry.sessionId,
    width: shot?.width,
    height: shot?.height,
  })
  return true
}

// Excluir o canvas na galeria apaga o de verdade (a pasta, o registro e o
// watcher) — excluir é liberar espaço, não só a capa.
setMediaDeleteHook('design', async (entry) => {
  if (entry.designId) await deleteDesignCanvas(entry.designId)
})
