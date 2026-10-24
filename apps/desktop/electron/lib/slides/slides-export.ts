import { BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { SLIDES_SCHEME } from '@shared/media'
import { parseDeckSize, type DeckSize } from './slides-deck'
import { SLIDES_HEIGHT, SLIDES_WIDTH } from './slides-runtime'
import { getSlides } from './slides-store'

/**
 * O PDF de um deck é a IMPRESSÃO do próprio `index.html`.
 *
 * Não existe um segundo formato: quem manda no layout é o arquivo, e o runtime
 * já sabe imprimir (o modo `?print=1` empilha os slides, um por página, com
 * `@page` do tamanho do palco). Aqui só se abre a janela oculta e se chama o
 * Chromium — o mesmo caminho do documento (media.ts:renderPdf), sem nenhuma
 * biblioteca de geração de PDF no projeto.
 *
 * A sessão é a DEFAULT de propósito: é nela que o `orbit-slides://` foi
 * registrado (registerSlidesProtocol). Uma partição nova exigiria registrar o
 * handler outra vez, como o renderPdf do documento faz com o artifact.
 *
 * == O tamanho da página, e a unidade que mente ==
 *
 * A tabela de tipos do Electron diz que um `pageSize` custom é um `Size` em
 * MICRONS. Na 44.3.0 (macOS) não é: o valor é lido como POLEGADAS. Passar
 * 338667x190500 "microns" não gera um erro claro — o printToPDF falha com
 * "Printing failed"; e 595x842 sai como uma folha de 595x842 POLEGADAS
 * (MediaBox 60624x42840), porque o valor é multiplicado por 72.
 *
 * Verificado imprimindo de verdade: 1280/96 x 720/96 polegadas dá exatamente
 * MediaBox [0 0 960 540] — 13,33x7,5 in, 16:9, sem margem.
 *
 * Como a documentação promete microns e a implementação usa polegadas, o
 * tamanho IMPRESSO é conferido com o próprio PDF, e há uma segunda tentativa
 * na outra unidade. Um Electron futuro que conserte a unidade não devolve um
 * deck de 0,35 mm — cai no retry. (Um tamanho grande demais também estoura um
 * limite de 16 bits da caixa: 960x540 polegadas = 69120 pt > 65535 pt.)
 */

/** Uma janela do Chromium por PDF: se o load travar, desiste em vez de vazar. */
const PRINT_TIMEOUT_MS = 15_000

/** Microns por pixel CSS (96 dpi) — a unidade que a documentação promete. */
export const MICRONS_PER_PX = (25.4 * 1000) / 96

/** Pontos por pixel CSS: o palco em px, na unidade em que o PDF mede páginas. */
export const POINTS_PER_PX = 72 / 96

export function micronsFor(px: number): number {
  return Math.round(px * MICRONS_PER_PX)
}

/** O palco em polegadas — a unidade que o Electron deste repo realmente lê. */
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

/** O tamanho que a página DEVE ter, em pontos: o que o deck pediu. */
function expectedPoints(size: DeckSize): PageSize {
  return { width: size.width * POINTS_PER_PX, height: size.height * POINTS_PER_PX }
}

/** Tamanho real da primeira página do PDF impresso (null se não der para ler). */
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

/** Meio ponto de folga: arredondamento de ponto flutuante, não erro de unidade. */
function isExpectedSize(measured: PageSize, expected: PageSize): boolean {
  return Math.abs(measured.width - expected.width) <= 0.5 && Math.abs(measured.height - expected.height) <= 0.5
}

async function printDeck(win: BrowserWindow, pageSize: PageSize): Promise<Buffer | null> {
  try {
    return await win.webContents.printToPDF({
      printBackground: true,
      pageSize,
      // Zero: a margem já é o padding do slide, e somar as duas encolheria o
      // conteúdo dentro da página.
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    })
  } catch {
    return null
  }
}

/**
 * Imprime o deck. `null` quando o deck saiu do registro, o arquivo não abre ou
 * nenhuma das unidades produziu a página certa — quem chama decide a mensagem.
 */
export async function renderSlidesPdf(id: string): Promise<Buffer | null> {
  const deck = await getSlides(id)
  if (!deck) return null

  let size: DeckSize = { width: SLIDES_WIDTH, height: SLIDES_HEIGHT }
  try {
    // O tamanho vem do deck, não de uma constante: um deck 4:3 ou 1920x1080
    // sairia cortado (ou com faixa branca) numa página 16:9 fixa.
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

    // O runtime já espera as fontes para montar o palco; na impressão a espera
    // é a mesma, do lado de fora — imprimir antes disso sai com a fonte de
    // fallback métrica diferente e o texto reflui.
    await target.webContents
      .executeJavaScript('document.fonts.ready.then(() => true)')
      .catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (target.isDestroyed()) return null

    const first = await printDeck(target, inchesOf(size))
    if (first) {
      const measured = await measurePage(first)
      // Sem conseguir medir, confia: o PDF existe, e recusá-lo seria pior.
      if (!measured || isExpectedSize(measured, expected)) return first
    }

    // A página saiu de outro tamanho: a unidade mudou (ver o bloco acima).
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
