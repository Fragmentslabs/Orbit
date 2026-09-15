import { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Rasteriza páginas de PDF em imagem.
 *
 * É o que torna um PDF DIGITALIZADO legível: sem camada de texto, extrair
 * caracteres devolve string vazia e a única forma de ler é o modelo OLHAR a
 * página. Serve também para conferir layout e para miniatura.
 *
 * Roda numa JANELA OCULTA, e não no processo main, por uma razão medida: o
 * pdfjs no main quebra com `DataCloneError: Cannot transfer object of
 * unsupported type` assim que o PDF tem imagem embutida — o worker falso dele
 * tenta transferir objetos de canvas nativo que o structuredClone do Node não
 * clona. Justamente o caso do PDF digitalizado, que é o principal. No renderer
 * o Chromium é um navegador de verdade e o pdfjs funciona sem contorção.
 *
 * Nenhum binário externo: nada de LibreOffice, Poppler ou Ghostscript
 * instalados na máquina do usuário.
 */

const _require = createRequire(import.meta.url)

/** Teto de páginas por chamada — rasterizar é caro e cada imagem custa
 *  contexto do modelo. */
export const MAX_RASTER_PAGES = 5
const LOAD_TIMEOUT_MS = 30_000

/** Retângulo em pixels da imagem renderizada (origem no canto superior
 *  esquerdo), pronto para virar um overlay sobre a página. */
export interface HighlightRect {
  x: number
  y: number
  width: number
  height: number
}

/** Entrada do sumário do PDF, já achatada com o nível de indentação. */
export interface PdfOutlineItem {
  title: string
  /** null quando o destino não resolve para uma página. */
  page: number | null
  level: number
}

interface RasterizedPage {
  pageNumber: number
  png: Buffer
  width: number
  height: number
  /** Onde os trechos procurados estão na página. Vazio quando não se pediu
   *  destaque ou quando o texto não foi encontrado ali. */
  highlights: HighlightRect[]
}

/** Fonte do pdfjs, lida uma vez por processo (são ~3MB entre lib e worker). */
let sourcesPromise: Promise<{ lib: string; worker: string }> | null = null

function pdfjsDir(): string {
  // resolve pelo pacote, e não por um caminho relativo montado à mão: num app
  // empacotado o node_modules pode estar dentro do asar.
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
 * Manda um arquivo para a impressora pelo diálogo do sistema.
 *
 * Abre numa janela oculta com o visualizador embutido: é o Chromium que sabe
 * paginar um PDF para papel, e refazer isso a partir das imagens que
 * desenhamos daria um resultado pior justamente onde ele precisa ser fiel.
 */
export async function printFile(filePath: string): Promise<{ ok: boolean; error?: string }> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // plugins: liga o visualizador de PDF embutido, sem o qual a janela
      // baixaria o arquivo em vez de renderizá-lo.
      plugins: true,
      partition: `doc-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  try {
    await win.loadURL(pathToFileURL(filePath).toString())
    return await new Promise((resolve) => {
      win.webContents.print({ silent: false }, (success, reason) => {
        resolve(success ? { ok: true } : { ok: false, error: reason })
      })
    })
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * Renderiza as páginas pedidas. `pages` é 1-indexado; páginas fora do
 * documento são ignoradas em silêncio (quem chama compara com `total`).
 */
export async function rasterizePdf(
  bytes: Buffer,
  options: { pages?: number[]; scale?: number; highlight?: string[]; includeOutline?: boolean } = {},
): Promise<{ total: number; pages: RasterizedPage[]; outline: PdfOutlineItem[] }> {
  const { lib, worker } = await loadSources()
  const wanted = (options.pages ?? [1]).slice(0, MAX_RASTER_PAGES)
  const scale = Math.min(3, Math.max(0.5, options.scale ?? 1.5))
  const highlight = (options.highlight ?? []).filter((t) => t.trim().length > 2).slice(0, 20)

  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        // Partição efêmera: o PDF é conteúdo do usuário, não divide storage
        // com nada do app.
        partition: `pdf-raster-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    const target = win
    await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body></body>'))

    // O PDF e o pdfjs entram como texto no script avaliado. Passar por
    // executeJavaScript evita ter que servir arquivo por protocolo ou copiar
    // o pdfjs para dentro do build.
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
        const wantedText = ${JSON.stringify(highlight)}
        // Compara sem espaços: o PDF quebra a frase em vários itens de texto e
        // a posição dos espaços entre eles não é confiável — colar tudo e
        // procurar o trecho igualmente colado é o que casa na prática.
        const squash = (s) => s.replace(/\\s+/g, '')

        /** Retângulos dos itens que cobrem o trecho, na escala da imagem. */
        const locate = (items, viewport, needle) => {
          const target = squash(needle)
          if (target.length < 3) return []
          let flat = ''
          const spans = []
          for (const item of items) {
            const piece = squash(item.str ?? '')
            if (!piece) continue
            spans.push({ from: flat.length, to: flat.length + piece.length, item })
            flat += piece
          }
          // TODAS as ocorrências, e não só a primeira: no Localizar a palavra
          // costuma repetir na mesma página, e marcar uma só faria o contador
          // dizer 7 enquanto a página mostra 1.
          const rects = []
          let at = flat.indexOf(target)
          while (at >= 0 && rects.length < 200) {
            const end = at + target.length
            for (const span of spans) {
              if (span.to <= at || span.from >= end) continue
              const tx = pdfjs.Util.transform(viewport.transform, span.item.transform)
              const height = Math.hypot(tx[2], tx[3]) || span.item.height * ${scale}
              rects.push({
                x: tx[4],
                y: tx[5] - height,
                width: (span.item.width ?? 0) * ${scale},
                height,
              })
            }
            at = flat.indexOf(target, at + Math.max(1, target.length))
          }
          return rects
        }

        /** Sumário do PDF, achatado com o nível de cada entrada. */
        const readOutline = async () => {
          const raiz = await doc.getOutline()
          if (!raiz || raiz.length === 0) return []
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
                // destino exótico: a entrada ainda vale como título
              }
              out.push({ title: String(item.title ?? '').trim(), page: pageNumber, level })
              if (item.items && item.items.length > 0 && level < 3) await walk(item.items, level + 1)
              if (out.length > 500) return
            }
          }
          await walk(raiz, 0)
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
          let highlights = []
          if (wantedText.length > 0) {
            const content = await page.getTextContent()
            for (const needle of wantedText) {
              highlights = highlights.concat(locate(content.items, viewport, needle))
            }
          }
          out.push({
            pageNumber: n,
            width: canvas.width,
            height: canvas.height,
            dataUrl: canvas.toDataURL('image/png'),
            highlights,
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
          highlights: HighlightRect[]
        }[]
        outline: PdfOutlineItem[]
      }>,
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), LOAD_TIMEOUT_MS)),
    ])
    if (outcome === TIMED_OUT) throw new Error('tempo esgotado ao renderizar o PDF')

    return {
      total: outcome.total,
      outline: outcome.outline ?? [],
      pages: outcome.pages.map((p) => ({
        pageNumber: p.pageNumber,
        width: p.width,
        height: p.height,
        png: Buffer.from(p.dataUrl.slice(p.dataUrl.indexOf(',') + 1), 'base64'),
        highlights: p.highlights ?? [],
      })),
    }
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}
