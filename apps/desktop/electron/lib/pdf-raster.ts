import { app, BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Rasterizes PDF pages into images.
 *
 * It is what makes a SCANNED PDF readable: without a text layer, extracting
 * characters returns an empty string and the only way to read is for the model to LOOK at the
 * page. It also serves to check the layout and for a thumbnail.
 *
 * It runs in a HIDDEN WINDOW, and not in the main process, for a measured reason: pdfjs
 * in the main breaks with `DataCloneError: Cannot transfer object of
 * unsupported type` as soon as the PDF has an embedded image — its fake worker
 * tries to transfer native canvas objects that Node's structuredClone does not
 * clone. Precisely the case of a scanned PDF, which is the main one. In the renderer
 * Chromium is a real browser and pdfjs works without contortion.
 *
 * No external binary: no LibreOffice, Poppler or Ghostscript
 * installed on the user's machine.
 */

const _require = createRequire(import.meta.url)

/** Page ceiling per call — rasterizing is expensive and each image costs
 *  the model's context. */
export const MAX_RASTER_PAGES = 5
const LOAD_TIMEOUT_MS = 30_000

/**
 * One text item of the page, as a FRACTION of its dimensions (0 to 1).
 *
 * Normalized on purpose: it is what allows changing the zoom without reprocessing
 * anything — the same list serves for any scale. And it is from here that the
 * renderer draws the highlight and the selection layer, without having to ask the
 * main for every letter typed in the search.
 */
export interface PdfTextItem {
  x: number
  y: number
  width: number
  height: number
  text: string
}

/** Entry of the PDF outline, already flattened with the indentation level. */
export interface PdfOutlineItem {
  title: string
  /** null when the destination does not resolve to a page. */
  page: number | null
  level: number
}

interface RasterizedPage {
  pageNumber: number
  png: Buffer
  width: number
  height: number
  /** The page's text with the position of each piece. */
  items: PdfTextItem[]
}

/** Source of pdfjs, read once per process (~3MB between lib and worker). */
let sourcesPromise: Promise<{ lib: string; worker: string }> | null = null

function pdfjsDir(): string {
  // resolved by the package, and not by a relative path assembled by hand: in a
  // packaged app node_modules may be inside the asar.
  const entry = _require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
  return path.dirname(entry)
}

async function loadSources(): Promise<{ lib: string; worker: string }> {
  if (!sourcesPromise) {
    sourcesPromise = (async () => {
      const dir = pdfjsDir()
      const [lib, worker] = await Promise.all([
        fsp.readFile(path.join(dir, 'pdf.mjs'), 'utf8'),
        fsp.readFile(path.join(dir, 'pdf.worker.mjs'), 'utf8'),
      ])
      return { lib, worker }
    })().catch((err) => {
      sourcesPromise = null
      throw err
    })
  }
  return sourcesPromise
}

/**
 * Path that the embedded viewer accepts opening.
 *
 * Chromium decides by the EXTENSION what to do with a file://. The original of
 * a source is stored as `<id>.bin`, and with that extension it DOWNLOADS the
 * file instead of opening the viewer — that was the "save a .bin" instead of the
 * print dialog. Measured: the same content as `.pdf` loads with
 * contentType application/pdf; as `.bin` it triggers will-download.
 *
 * Split out so it can be tested without opening any print dialog.
 */
export async function printablePath(
  filePath: string,
): Promise<{ path: string; cleanup: () => void }> {
  if (filePath.toLowerCase().endsWith('.pdf')) return { path: filePath, cleanup: () => {} }
  const copy = path.join(
    app.getPath('temp'),
    `orbit-print-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.pdf`,
  )
  await fsp.copyFile(filePath, copy)
  return {
    path: copy,
    // Only after the dialog resolves: deleting before would take the file out from under
    // the very viewer that is going to generate the pages.
    cleanup: () => void fsp.rm(copy, { force: true }).catch(() => {}),
  }
}

/** Safety net: an abandoned print window does not stay forever. */
const PRINT_WINDOW_TTL_MS = 10 * 60_000
/** Ceiling of the wait for the first paint before opening the dialog. */
const FIRST_PAINT_TIMEOUT_MS = 3000

/**
 * Waits for the window to actually PAINT.
 *
 * `ready-to-show` does not serve here: it fires when the page is ready
 * (measured: 107ms), but the PDF viewer is a plugin and draws later —
 * capturing at that instant returns a flat rectangle. That is why the
 * print window stayed gray: the dialog, modal, opened before the first
 * frame and froze the window in that state.
 *
 * So instead of nailing down a number of milliseconds, it measures what matters:
 * it captures until the image stops being flat. Measured ~277ms on a common PDF.
 */
async function waitForFirstPaint(win: BrowserWindow): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < FIRST_PAINT_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (win.isDestroyed()) return false
    try {
      const bitmap = (await win.capturePage()).toBitmap()
      const counts = new Map<number, number>()
      for (let i = 0; i < bitmap.length; i += 4) {
        // Coarse color (4 bits per channel): antialiasing does not count as
        // content, but text and frames do.
        const key = (bitmap[i + 2] >> 4) * 256 + (bitmap[i + 1] >> 4) * 16 + (bitmap[i] >> 4)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const total = bitmap.length / 4
      if (total > 0 && (total - Math.max(...counts.values(), 0)) / total > 0.05) return true
    } catch {
      // Nothing composited yet (UnknownVizError) — keeps waiting.
    }
  }
  return false
}

/**
 * Opens the system print dialog for a file.
 *
 * The document is loaded in a window with the embedded viewer: it is
 * Chromium that knows how to page a PDF for paper, and redoing that from the
 * images we draw would give a worse result precisely where it has to
 * be faithful.
 *
 * Two decisions came from the button spinning forever:
 *
 * 1. The window is VISIBLE. With `show: false` the dialog has nowhere to anchor and
 *    stays waiting for an interaction nobody can perform. Measured: with
 *    `silent: true` (no dialog) the callback returns in ~1s even hidden, so
 *    what was stuck was the dialog, not the print.
 * 2. The function returns when the dialog OPENS, not when the print ends.
 *    Waiting for the end is waiting for the user — and that is what kept the UI
 *    loading. Whoever reports the work's result is the dialog itself.
 */
export async function printFile(
  filePath: string,
  title?: string,
): Promise<{ ok: boolean; error?: string }> {
  let printable: { path: string; cleanup: () => void }
  try {
    printable = await printablePath(filePath)
  } catch (err) {
    return { ok: false, error: `Could not prepare the file: ${(err as Error).message}` }
  }

  const win = new BrowserWindow({
    // It starts hidden and appears after loading, so as not to blink white.
    show: false,
    width: 720,
    height: 860,
    // Child of the app window: it stays above it, disappears with it and does not become a
    // second loose entry in the taskbar.
    parent: BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
    title: title || path.basename(filePath),
    // Without Electron's menu bar: this window exists only to host the
    // dialog, and a File/Edit/View menu there leads nowhere.
    autoHideMenuBar: true,
    webPreferences: {
      // plugins: it turns on the embedded PDF viewer, without which the window
      // would download the file instead of rendering it.
      plugins: true,
      partition: `doc-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    printable.cleanup()
    if (!win.isDestroyed()) win.destroy()
  }

  // The PDF viewer renames the window with the name of the FILE, which here is
  // the temporary copy (`orbit-print-mu23….pdf`). Holding the title keeps on
  // screen the name of the document the user asked to print.
  win.setMenuBarVisibility(false)
  win.on('page-title-updated', (event) => event.preventDefault())

  try {
    await win.loadURL(pathToFileURL(printable.path).toString())
  } catch (err) {
    finish()
    return { ok: false, error: (err as Error).message }
  }

  win.show()
  // Closing the window midway is giving up on printing — and it has to clean up the same way.
  win.on('closed', () => {
    finished = true
    printable.cleanup()
  })

  // The dialog is modal: opening it before the first frame leaves the window gray
  // behind it until the end. If the paint does not come within the ceiling, it prints anyway —
  // an ugly preview is better than not printing.
  await waitForFirstPaint(win)
  if (win.isDestroyed()) return { ok: false, error: 'The print window was closed.' }

  win.webContents.print({ silent: false }, () => finish())
  setTimeout(finish, PRINT_WINDOW_TTL_MS)

  return { ok: true }
}

/**
 * Renders the requested pages. `pages` is 1-indexed; pages outside the
 * document are ignored silently (whoever calls compares with `total`).
 */
export async function rasterizePdf(
  bytes: Buffer,
  options: { pages?: number[]; scale?: number; includeText?: boolean; includeOutline?: boolean } = {},
): Promise<{ total: number; pages: RasterizedPage[]; outline: PdfOutlineItem[] }> {
  const { lib, worker } = await loadSources()
  const wanted = (options.pages ?? [1]).slice(0, MAX_RASTER_PAGES)
  const scale = Math.min(3, Math.max(0.5, options.scale ?? 1.5))

  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        // Ephemeral partition: the PDF is the user's content, it does not share storage
        // with anything in the app.
        partition: `pdf-raster-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    const target = win
    await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body></body>'))

    // The PDF and pdfjs enter as text in the evaluated script. Going through
    // executeJavaScript avoids having to serve a file by protocol or copy
    // pdfjs into the build.
    const script = `
      (async () => {
        const libUrl = URL.createObjectURL(new Blob([${JSON.stringify(lib)}], { type: 'text/javascript' }))
        const workerUrl = URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: 'text/javascript' }))
        const pdfjs = await import(libUrl)
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        const raw = atob(${JSON.stringify(bytes.toString('base64'))})
        const data = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i)
        const doc = await pdfjs.getDocument({ data }).promise
        const wantText = ${JSON.stringify(Boolean(options.includeText))}

        /** Text items of the page, as a fraction of its dimensions. */
        const readItems = (items, viewport) => {
          const out = []
          for (const item of items) {
            const text = item.str ?? ''
            if (!text) continue
            const tx = pdfjs.Util.transform(viewport.transform, item.transform)
            const glyphHeight = Math.hypot(tx[2], tx[3]) || (item.height ?? 0) * ${scale}
            out.push({
              x: tx[4] / viewport.width,
              y: (tx[5] - glyphHeight) / viewport.height,
              width: ((item.width ?? 0) * ${scale}) / viewport.width,
              height: glyphHeight / viewport.height,
              text: text,
            })
            if (out.length > 4000) break
          }
          return out
        }

        /** Summary of the PDF, flattened with the level of each entry. */
        const readOutline = async () => {
          const outline = await doc.getOutline()
          if (!outline || outline.length === 0) return []
          const out = []
          const walk = async (items, level) => {
            for (const item of items) {
              let pageNumber = null
              try {
                const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest
                if (Array.isArray(dest) && dest[0]) {
                  pageNumber = (await doc.getPageIndex(dest[0])) + 1
                }
              } catch {
                // exotic destination: the entry still counts as a title
              }
              out.push({ title: String(item.title ?? '').trim(), page: pageNumber, level })
              if (item.items && item.items.length > 0 && level < 3) await walk(item.items, level + 1)
              if (out.length > 500) return
            }
          }
          await walk(outline, 0)
          return out
        }

        const out = []
        for (const n of ${JSON.stringify(wanted)}) {
          if (n < 1 || n > doc.numPages) continue
          const page = await doc.getPage(n)
          const viewport = page.getViewport({ scale: ${scale} })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
          let items = []
          if (wantText) {
            const content = await page.getTextContent()
            items = readItems(content.items, viewport)
          }
          out.push({
            pageNumber: n,
            width: canvas.width,
            height: canvas.height,
            dataUrl: canvas.toDataURL('image/png'),
            items,
          })
        }
        const outline = ${JSON.stringify(Boolean(options.includeOutline))} ? await readOutline() : []
        return { total: doc.numPages, pages: out, outline }
      })()
    `
    const TIMED_OUT = Symbol('rasterTimeout')
    const outcome = await Promise.race([
      target.webContents.executeJavaScript(script) as Promise<{
        total: number
        pages: {
          pageNumber: number
          width: number
          height: number
          dataUrl: string
          items: PdfTextItem[]
        }[]
        outline: PdfOutlineItem[]
      }>,
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), LOAD_TIMEOUT_MS)),
    ])
    if (outcome === TIMED_OUT) throw new Error('timed out while rendering the PDF')

    return {
      total: outcome.total,
      outline: outcome.outline ?? [],
      pages: outcome.pages.map((p) => ({
        pageNumber: p.pageNumber,
        width: p.width,
        height: p.height,
        png: Buffer.from(p.dataUrl.slice(p.dataUrl.indexOf(',') + 1), 'base64'),
        items: p.items ?? [],
      })),
    }
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}
