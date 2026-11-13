import { BrowserWindow } from 'electron'
import { PDFDocument } from 'pdf-lib'
import { DESIGN_SCHEME } from '@shared/media'
import { readDesignCanvas } from './design-canvas'
import { getDesign } from './design-store'

/**
 * Export of a design canvas: every artboard is printed from its own HTML file,
 * in a hidden window of the exact size of the artboard (what the person sees on
 * the canvas is what comes out). PDF = one page per artboard, each with its own
 * size, back to front like the canvas `order`; PNG = one image per artboard.
 *
 * Same default session as the slides export: it is the one where
 * `orbit-design://` was registered.
 */

const LOAD_TIMEOUT_MS = 15_000
const MIN_SIDE = 16
const MAX_SIDE = 8000

export interface ExportedBoard {
  file: string
  title: string
  width: number
  height: number
  png?: Buffer
  pdf?: Buffer
}

function clampSide(value: number): number {
  if (!Number.isFinite(value)) return 800
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(value)))
}

async function withBoardWindow<T>(
  id: string,
  file: string,
  width: number,
  height: number,
  run: (win: BrowserWindow) => Promise<T>,
): Promise<T | null> {
  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    const target = win
    await Promise.race([
      target.loadURL(`${DESIGN_SCHEME}://${id}/${encodeURIComponent(file)}`).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS)),
    ])
    if (target.isDestroyed()) return null
    await target.webContents.executeJavaScript('document.fonts.ready.then(() => true)').catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (target.isDestroyed()) return null
    return await run(target)
  } catch {
    return null
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

/** Renders every artboard of the canvas. `null` when the canvas left the registry. */
export async function renderDesignBoards(
  id: string,
  format: 'png' | 'pdf',
  only?: string[],
): Promise<ExportedBoard[] | null> {
  const entry = await getDesign(id)
  if (!entry) return null
  let canvas
  try {
    canvas = await readDesignCanvas(entry.folder)
  } catch {
    return null
  }
  const out: ExportedBoard[] = []
  for (const file of canvas.order) {
    if (only && !only.includes(file)) continue
    const board = canvas.boards[file]
    if (!board) continue
    // "Export all" is the SCREENS: a loose piece is only exported when it was asked for by name.
    if (!only && board.free) continue
    const width = clampSide(board.w)
    const height = clampSide(board.h)
    const title = board.title?.trim() || file.replace(/\.html?$/i, '')
    const rendered = await withBoardWindow(id, file, width, height, async (win) => {
      if (format === 'png') {
        const image = await win.webContents.capturePage({ x: 0, y: 0, width, height })
        return image.toPNG()
      }
      // Inches: the unit this Electron really reads (see slides-export).
      return win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: width / 96, height: height / 96 },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      })
    })
    if (!rendered) continue
    out.push({ file, title, width, height, ...(format === 'png' ? { png: rendered } : { pdf: rendered }) })
  }
  return out.length > 0 ? out : null
}

/** One PDF with a page per artboard (each page already has the artboard's size). */
export async function renderDesignPdf(id: string, only?: string[]): Promise<Buffer | null> {
  const boards = await renderDesignBoards(id, 'pdf', only)
  if (!boards) return null
  const merged = await PDFDocument.create()
  for (const board of boards) {
    if (!board.pdf) continue
    try {
      const doc = await PDFDocument.load(board.pdf, { ignoreEncryption: true })
      const pages = await merged.copyPages(doc, [0])
      merged.addPage(pages[0])
    } catch {
      /* an artboard that did not print does not cancel the others */
    }
  }
  if (merged.getPageCount() === 0) return null
  return Buffer.from(await merged.save())
}
