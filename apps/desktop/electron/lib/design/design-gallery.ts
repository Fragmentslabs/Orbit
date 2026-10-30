import { DESIGN_SCHEME } from '@shared/media'
import { BrowserWindow } from 'electron'
import path from 'node:path'
import sharp from 'sharp'
import { saveDesignMedia, setMediaDeleteHook } from '../media'
import { readDesignCanvas } from './design-canvas'
import { deleteDesignCanvas, getDesign } from './design-store'

/**
 * The COVER of a design canvas, and its record in the gallery — mirrors
 * video/motion-gallery.ts. The thumbnail is the FIRST artboard (`order[0]`),
 * photographed in an offscreen window at its own size; no seek and no layer
 * measurement, because the artboard is static.
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
    // Without this Chromium does not paint a window that was never shown.
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
    // A moment for Chromium to finish painting.
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

/** Floor between two captures of the SAME canvas: a burst of edits must not
 *  open an offscreen window per call. */
const MIN_REFRESH_MS = 10_000

interface CoverJob {
  running: boolean
  /** The canvas changed again while the shot was being taken: redo it when done. */
  again: boolean
  lastAt: number
  opts: { title?: string; sessionId?: string }
}

const coverJobs = new Map<string, CoverJob>()

/**
 * Puts (or updates) the canvas cover in the gallery WITHOUT holding up the caller.
 *
 * Capturing costs opening an offscreen window, loading the artboard, waiting for
 * the fonts and for sharp to resize — 0.4–2 s (up to 15 s in the worst case) that
 * used to sit at the end of design_write/design_edit, delaying the tool result.
 * Here the capture becomes background work: the tool answers right away and the
 * tile shows up a moment later. It is idempotent (the item is the `designId`, not
 * the moment) and a burst of edits becomes a single capture — the last one wins.
 */
export function refreshDesignCover(id: string, opts: { title?: string; sessionId?: string } = {}): void {
  const job = coverJobs.get(id) ?? { running: false, again: false, lastAt: 0, opts: {} }
  coverJobs.set(id, job)
  job.opts = { ...job.opts, ...opts }
  if (job.running) {
    job.again = true
    return
  }
  if (Date.now() - job.lastAt < MIN_REFRESH_MS) return
  void shoot(job, id)
}

async function shoot(job: CoverJob, id: string): Promise<void> {
  job.running = true
  try {
    const entry = await getDesign(id)
    if (entry) {
      const shot = await captureCover(id, entry.folder).catch(() => null)
      await saveDesignMedia(shot?.png ?? null, {
        designId: id,
        title: job.opts.title ?? path.basename(entry.folder),
        directory: entry.root,
        sessionId: job.opts.sessionId ?? entry.sessionId,
        width: shot?.width,
        height: shot?.height,
      })
    }
  } catch {
    // The cover is an accessory: no failure here can surface anywhere else.
  } finally {
    job.running = false
    job.lastAt = Date.now()
    // The job STAYS in the map: it is its `lastAt` that holds back the next capture of
    // the same canvas (one per canvas, cheap).
    if (job.again) {
      job.again = false
      void shoot(job, id)
    }
  }
}

// Deleting the canvas in the gallery deletes the real thing (the folder, the record
// and the watcher) — deleting frees space, it is not just the cover.
setMediaDeleteHook('design', async (entry) => {
  if (entry.designId) await deleteDesignCanvas(entry.designId)
})
