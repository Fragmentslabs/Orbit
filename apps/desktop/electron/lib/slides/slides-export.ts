import { BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { SLIDES_SCHEME } from '@shared/media'
import { parseDeckSize, type DeckSize } from './slides-deck'
import { SLIDES_HEIGHT, SLIDES_WIDTH } from './slides-runtime'
import { getSlides } from './slides-store'

/**
 * A deck's PDF is the PRINT of its own `index.html`.
 *
 * There is no second format: the file rules the layout, and the runtime already
 * knows how to print (the `?print=1` mode stacks the slides, one per page, with a
 * `@page` the size of the stage). Here we only open the hidden window and call
 * Chromium — the same path as the document (media.ts:renderPdf), with no
 * PDF-generation library in the project.
 *
 * The session is the DEFAULT one on purpose: it is in it that `orbit-slides://` was
 * registered (registerSlidesProtocol). A new partition would require registering
 * the handler again, as renderPdf of the document does with the artifact.
 *
 * == The page size, and the unit that lies ==
 *
 * Electron's type table says a custom `pageSize` is a `Size` in MICRONS. In
 * 44.3.0 (macOS) it is not: the value is read as INCHES. Passing
 * 338667x190500 "microns" does not produce a clear error — printToPDF fails with
 * "Printing failed"; and 595x842 comes out as a sheet of 595x842 INCHES
 * (MediaBox 60624x42840), because the value is multiplied by 72.
 *
 * Verified by really printing: 1280/96 x 720/96 inches gives exactly
 * MediaBox [0 0 960 540] — 13.33x7.5 in, 16:9, no margin.
 *
 * Since the documentation promises microns and the implementation uses inches, the
 * PRINTED size is checked against the PDF itself, and there is a second attempt in
 * the other unit. A future Electron that fixes the unit does not return a deck of
 * 0.35 mm — it falls into the retry. (A size that is too large also blows a 16-bit
 * limit of the box: 960x540 inches = 69120 pt > 65535 pt.)
 */

/** One Chromium window per PDF: if the load hangs, give up instead of leaking. */
const PRINT_TIMEOUT_MS = 15_000

/** Microns per CSS pixel (96 dpi) — the unit the documentation promises. */
export const MICRONS_PER_PX = (25.4 * 1000) / 96

/** Points per CSS pixel: the stage in px, in the unit the PDF measures pages in. */
export const POINTS_PER_PX = 72 / 96

export function micronsFor(px: number): number {
  return Math.round(px * MICRONS_PER_PX)
}

/** The stage in inches — the unit this repo's Electron actually reads. */
export function inchesFor(px: number): number {
  return px / 96
}

interface PageSize {
  width: number
  height: number
}

function inchesOf(size: DeckSize): PageSize {
  return { width: inchesFor(size.width), height: inchesFor(size.height) }
}

function micronsOf(size: DeckSize): PageSize {
  return { width: micronsFor(size.width), height: micronsFor(size.height) }
}

/** The size the page MUST have, in points: what the deck asked for. */
function expectedPoints(size: DeckSize): PageSize {
  return { width: size.width * POINTS_PER_PX, height: size.height * POINTS_PER_PX }
}

/** Real size of the first page of the printed PDF (null if it cannot be read). */
async function measurePage(pdf: Buffer): Promise<PageSize | null> {
  try {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true })
    const page = doc.getPages()[0]
    if (!page) return null
    const { width, height } = page.getSize()
    return { width, height }
  } catch {
    return null
  }
}

/** Half a point of slack: floating point rounding, not a unit error. */
function isExpectedSize(measured: PageSize, expected: PageSize): boolean {
  return Math.abs(measured.width - expected.width) <= 0.5 && Math.abs(measured.height - expected.height) <= 0.5
}

async function printDeck(win: BrowserWindow, pageSize: PageSize): Promise<Buffer | null> {
  try {
    return await win.webContents.printToPDF({
      printBackground: true,
      pageSize,
      // Zero: the margin already is the slide padding, and adding both would shrink the
      // content inside the page.
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    })
  } catch {
    return null
  }
}

/**
 * Prints the deck. `null` when the deck left the registry, the file does not open
 * or none of the units produced the right page — the caller decides the message.
 */
export async function renderSlidesPdf(id: string): Promise<Buffer | null> {
  const deck = await getSlides(id)
  if (!deck) return null

  let size: DeckSize = { width: SLIDES_WIDTH, height: SLIDES_HEIGHT }
  try {
    // The size comes from the deck, not from a constant: a 4:3 or 1920x1080 deck
    // would come out cropped (or with a white band) on a fixed 16:9 page.
    size = parseDeckSize(await fsp.readFile(deck.entry, 'utf8'), size)
  } catch {
    return null
  }

  const relative = path.relative(deck.folder, deck.entry).split(path.sep).join('/')
  const expected = expectedPoints(size)

  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: size.width,
      height: size.height,
      paintWhenInitiallyHidden: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    const target = win
    await Promise.race([
      target.loadURL(`${SLIDES_SCHEME}://${id}/${relative}?print=1`).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, PRINT_TIMEOUT_MS)),
    ])
    if (target.isDestroyed()) return null

    // The runtime already waits for the fonts to build the stage; when printing the wait
    // is the same, from the outside — printing before that comes out with the
    // fallback font of a different metric and the text reflows.
    await target.webContents
      .executeJavaScript('document.fonts.ready.then(() => true)')
      .catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (target.isDestroyed()) return null

    const first = await printDeck(target, inchesOf(size))
    if (first) {
      const measured = await measurePage(first)
      // Unable to measure it, trust it: the PDF exists, and refusing it would be worse.
      if (!measured || isExpectedSize(measured, expected)) return first
    }

    // The page came out at another size: the unit changed (see the block above).
    const second = await printDeck(target, micronsOf(size))
    if (second) {
      const measured = await measurePage(second)
      if (!measured || isExpectedSize(measured, expected)) return second
    }
    return null
  } catch {
    return null
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}
