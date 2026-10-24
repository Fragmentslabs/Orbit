import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * A janela oculta é falsa, mas o printToPDF é de VERDADE no que importa: ele
 * monta um PDF cujo tamanho de página segue a unidade configurada. É assim que
 * o teste pega o erro que a documentação do Electron esconde — o `pageSize`
 * custom é lido em POLEGADAS na 44.3.0, não em microns.
 */
const printed = vi.hoisted(() => ({
  urls: [] as string[],
  options: [] as Array<{ pageSize?: unknown; printBackground?: boolean; margins?: unknown }>,
  /** 'inches' imita o Electron do repo; 'microns' imita o que a doc promete. */
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
    // loadURL é da JANELA; o print mora no webContents.
    loadURL = async (url: string) => {
      printed.urls.push(url)
    }
    webContents = {
      // Devolve Promise de propósito: o exportador chama .catch() nisto.
      executeJavaScript: async () => true,
      printToPDF: async (options: { pageSize?: { width: number; height: number } }) => {
        printed.options.push(options as never)
        const size = options.pageSize ?? { width: 8.27, height: 11.69 }
        // 1 polegada = 72 pt; 1 micron = 72/25400 pt.
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

/** Um deck de verdade no disco: o exportador LÊ o arquivo para achar o tamanho. */
async function deckWith(html: string): Promise<string> {
  const folder = path.join(tempRoot, `deck-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, 'index.html'), html, 'utf8')
  const { id } = await registerSlides(folder)
  return id
}

const deck = (head = '') =>
  `<!doctype html><html><head>${head}</head><body><section class="slide">a</section></body></html>`

/** Tamanho da primeira página do PDF devolvido. */
async function pageOf(pdf: Buffer): Promise<{ width: number; height: number }> {
  const { PDFDocument } = await import('pdf-lib')
  return PDFDocument.load(pdf).then((doc) => doc.getPages()[0].getSize())
}

describe('unidades do papel', () => {
  it('converte px CSS para o ponto do PDF e para as duas unidades do Electron', () => {
    expect(POINTS_PER_PX).toBeCloseTo(0.75, 5)
    expect(inchesFor(1280)).toBeCloseTo(13.3333, 3)
    expect(MICRONS_PER_PX).toBeCloseTo(264.5833, 3)
    expect(micronsFor(1280)).toBe(338667)
  })
})

describe('renderSlidesPdf', () => {
  it('imprime 16:9 com o papel do tamanho do palco', async () => {
    printed.options.length = 0
    printed.urls.length = 0
    printed.unit = 'inches'
    const id = await deckWith(deck())
    const pdf = await renderSlidesPdf(id)
    unwatchSlides(id)

    expect(pdf?.subarray(0, 4).toString()).toBe('%PDF')
    expect(printed.urls[0]).toContain(`${id}/index.html?print=1`)
    // Uma tentativa só: a unidade bateu de primeira.
    expect(printed.options).toHaveLength(1)
    expect(printed.options[0].printBackground).toBe(true)
    expect(printed.options[0].margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
    // 1280x720 px a 96 dpi = 960x540 pt.
    expect(await pageOf(pdf as Buffer)).toEqual({ width: 960, height: 540 })
  })

  it('segue o tamanho declarado no meta do deck', async () => {
    printed.options.length = 0
    printed.unit = 'inches'
    const id = await deckWith(deck('<meta name="orbit-slides" content="width=1920,height=1080">'))
    const pdf = await renderSlidesPdf(id)
    unwatchSlides(id)

    expect(await pageOf(pdf as Buffer)).toEqual({ width: 1440, height: 810 })
  })

  it('refaz na outra unidade quando a página sai do tamanho pedido', async () => {
    printed.options.length = 0
    // Electron que lê microns (como a documentação promete): a primeira
    // tentativa, em polegadas, vira uma página de 13x7 MICRONS (~0,4 pt).
    printed.unit = 'microns'
    const id = await deckWith(deck())
    const pdf = await renderSlidesPdf(id)
    unwatchSlides(id)

    expect(printed.options).toHaveLength(2)
    // A segunda tentativa é a dos microns de verdade.
    expect(printed.options[1].pageSize).toEqual({ width: micronsFor(1280), height: micronsFor(720) })
    // Arredondar micron custa uma fração de ponto — não é erro de unidade.
    const page = await pageOf(pdf as Buffer)
    expect(page.width).toBeCloseTo(960, 1)
    expect(page.height).toBeCloseTo(540, 1)
  })

  it('devolve null para deck fora do registro', async () => {
    expect(await renderSlidesPdf('sld_naoexiste')).toBeNull()
  })
})
