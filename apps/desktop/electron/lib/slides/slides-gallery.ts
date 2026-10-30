import { SLIDES_SCHEME } from '@shared/media'
import { BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { saveSlidesMedia, setMediaDeleteHook } from '../media'
import { parseDeckSize } from './slides-deck'
import { deleteSlidesDeck, getSlides } from './slides-store'
import { SLIDES_HEIGHT, SLIDES_WIDTH } from './slides-runtime'

/**
 * The COVER of a deck and its record in the gallery — mirrors design-gallery.ts.
 *
 * The thumbnail is the FIRST slide, and it comes for free: the deck is served by
 * `orbit-slides://` with the runtime injected, which builds the stage and shows
 * slide 1. Photographing a window the size of the stage gives exactly the cover —
 * no seek, no layer measurement, no second source of truth for the layout.
 *
 * The window must have the EXACT size declared in the deck's meta: that is what
 * makes the runtime scale 1:1 and the capture come out without a bar.
 */

const COVER_WIDTH = 640
const LOAD_TIMEOUT_MS = 15_000

interface CoverShot {
  png: Buffer
  width: number
  height: number
}

async function captureCover(id: string, folder: string, entry: string): Promise<CoverShot | null> {
  const html = await fsp.readFile(entry, 'utf8').catch(() => null)
  const fallback = { width: SLIDES_WIDTH, height: SLIDES_HEIGHT }
  const size = html ? parseDeckSize(html, fallback) : fallback
  const width = Math.max(40, Math.round(size.width))
  const height = Math.max(40, Math.round(size.height))

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
    const relative = path
      .relative(folder, entry)
      .split(path.sep)
      .map(encodeURIComponent)
      .join('/')
    const url = `${SLIDES_SCHEME}://${id}/${relative}`
    await Promise.race([
      win.loadURL(url).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS)),
    ])
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true).catch(() => {})
    // A moment for the runtime to build the stage and Chromium to finish painting.
    await new Promise((resolve) => setTimeout(resolve, 250))
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
 * Puts (or updates) the deck in the gallery, with the cover taken now. Idempotent:
 * registering the same deck again lands on the SAME item — it is the `slidesId`
 * that rules, not the moment.
 */
export async function registerSlidesCover(
  id: string,
  opts: { title?: string; sessionId?: string } = {},
): Promise<boolean> {
  const entry = await getSlides(id)
  if (!entry) return false
  const shot = await captureCover(id, entry.folder, entry.entry).catch(() => null)
  await saveSlidesMedia(shot?.png ?? null, {
    slidesId: id,
    title: opts.title ?? path.basename(entry.folder),
    directory: entry.root,
    sessionId: opts.sessionId ?? entry.sessionId,
    width: shot?.width,
    height: shot?.height,
  })
  return true
}

// Deleting the deck in the gallery deletes the real thing (the folder, the record and
// the watcher) — deleting frees space. The safety locks stay in
// deleteSlidesDeck: the project itself is never deleted.
setMediaDeleteHook('slides', async (entry) => {
  if (entry.slidesId) await deleteSlidesDeck(entry.slidesId)
})
