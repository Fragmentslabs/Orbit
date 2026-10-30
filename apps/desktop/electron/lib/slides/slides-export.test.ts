import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * The hidden window is fake, but printToPDF is REAL where it matters: it builds a
 * PDF whose page size follows the configured unit. That is how the test catches the
 * bug the Electron documentation hides — the custom `pageSize` is read in INCHES
 * in 44.3.0, not in microns.
 */
const printed = vi.hoisted(() => ({
  urls: [] as string[],
  options: [] as Array<{ pageSize?: unknown; printBackground?: boolean; margins?: unknown }>,
  /** 'inches' imitates the Electron of the repo; 'microns' imitates what the doc promises. */
  unit: 'inches' as 'inches' | 'microns',
}))

vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  const { PDFDocument } = await import('pdf-lib')
  class FakeBrowserWindow {
    static getAllWindows() {
      return []
    }
    // loadURL belongs to the WINDOW; the print lives in webContents.
    loadURL = async (url: string) => {
      printed.urls.push(url)
    }
    webContents = {
      // Returns a Promise on purpose: the exporter calls .catch() on this.
      executeJavaScript: async () => true,
      printToPDF: async (options: { pageSize?: { width: number; height: number } }) => {
        printed.options.push(options as never)
        const size = options.pageSize ?? { width: 8.27, height: 11.69 }
        // 1 inch = 72 pt; 1 micron = 72/25400 pt.
        const factor = printed.unit === 'inches' ? 72 : 72 / 25400
        const doc = await PDFDocument.create()
        doc.addPage([size.width * factor, size.height * factor])
        return Buffer.from(await doc.save())
      },
    }
    constructor(readonly options: unknown) {}
    isDestroyed() {
      return false
    }
    destroy() {}
  }
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-slides-export-test-${process.pid}`) },
    BrowserWindow: FakeBrowserWindow,
    protocol: { handle: () => {} },
  }
})

const { registerSlides, unwatchSlides } = await import('./slides-store')
const { MICRONS_PER_PX, POINTS_PER_PX, inchesFor, micronsFor, renderSlidesPdf } = await import(
  './slides-export'
)

const tempRoot = path.join(os.tmpdir(), `orbit-slides-export-test-${process.pid}`)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

/** A real deck on disk: the exporter READS the file to find the size. */
async function deckWith(html: string): Promise<string> {
  const folder = path.join(tempRoot, `deck-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, 'index.html'), html, 'utf8')
  const { id } = await registerSlides(folder)
  return id
}

const deck = (head = '') =>
  `<!doctype html><html><head>${head}</head><body><section class="slide">a</section></body></html>`

/** Size of the first page of the returned PDF. */
async function pageOf(pdf: Buffer): Promise<{ width: number; height: number }> {
  const { PDFDocument } = await import('pdf-lib')
  return PDFDocument.load(pdf).then((doc) => doc.getPages()[0].getSize())
}

describe('unidades do papel', () => {
  it('converts CSS px to the PDF point and to the two Electron units', () => {
    expect(POINTS_PER_PX).toBeCloseTo(0.75, 5)
    expect(inchesFor(1280)).toBeCloseTo(13.3333, 3)
    expect(MICRONS_PER_PX).toBeCloseTo(264.5833, 3)
    expect(micronsFor(1280)).toBe(338667)
  })
})

describe('renderSlidesPdf', () => {
  it('prints 16:9 with the paper at the stage size', async () => {
    printed.options.length = 0
    printed.urls.length = 0
    printed.unit = 'inches'
    const id = await deckWith(deck())
    const pdf = await renderSlidesPdf(id)
    unwatchSlides(id)

    expect(pdf?.subarray(0, 4).toString()).toBe('%PDF')
    expect(printed.urls[0]).toContain(`${id}/index.html?print=1`)
    // A single attempt: the unit matched on the first try.
    expect(printed.options).toHaveLength(1)
    expect(printed.options[0].printBackground).toBe(true)
    expect(printed.options[0].margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
    // 1280x720 px at 96 dpi = 960x540 pt.
    expect(await pageOf(pdf as Buffer)).toEqual({ width: 960, height: 540 })
  })

  it('follows the size declared in the deck meta', async () => {
    printed.options.length = 0
    printed.unit = 'inches'
    const id = await deckWith(deck('<meta name="orbit-slides" content="width=1920,height=1080">'))
    const pdf = await renderSlidesPdf(id)
    unwatchSlides(id)

    expect(await pageOf(pdf as Buffer)).toEqual({ width: 1440, height: 810 })
  })

  it('redoes it in the other unit when the page comes out at the wrong size', async () => {
    printed.options.length = 0
    // An Electron that reads microns (as the documentation promises): the first
    // attempt, in inches, becomes a page of 13x7 MICRONS (~0.4 pt).
    printed.unit = 'microns'
    const id = await deckWith(deck())
    const pdf = await renderSlidesPdf(id)
    unwatchSlides(id)

    expect(printed.options).toHaveLength(2)
    // The second attempt is the real-micron one.
    expect(printed.options[1].pageSize).toEqual({ width: micronsFor(1280), height: micronsFor(720) })
    // Rounding a micron costs a fraction of a point — it is not a unit error.
    const page = await pageOf(pdf as Buffer)
    expect(page.width).toBeCloseTo(960, 1)
    expect(page.height).toBeCloseTo(540, 1)
  })

  it('returns null for a deck outside the registry', async () => {
    expect(await renderSlidesPdf('sld_naoexiste')).toBeNull()
  })
})
