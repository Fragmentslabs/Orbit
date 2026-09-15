import { app, BrowserWindow } from 'electron'
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

/**
 * Um item de texto da página, em FRAÇÃO das dimensões dela (0 a 1).
 *
 * Normalizado de propósito: é o que permite trocar o zoom sem reprocessar
 * nada — a mesma lista serve para qualquer escala. E é a partir daqui que o
 * renderer desenha o destaque e a camada de seleção, sem precisar pedir ao
 * main a cada letra digitada na busca.
 */
export interface PdfTextItem {
  x: number
  y: number
  width: number
  height: number
  text: string
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
  /** O texto da página com a posição de cada pedaço. */
  items: PdfTextItem[]
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
 * Caminho que o visualizador embutido aceita abrir.
 *
 * O Chromium decide pela EXTENSÃO o que fazer com um file://. O original de
 * uma fonte é guardado como `<id>.bin`, e com essa extensão ele BAIXA o
 * arquivo em vez de abrir o visualizador — era o "salvar um .bin" no lugar do
 * diálogo de impressão. Medido: o mesmo conteúdo como `.pdf` carrega com
 * contentType application/pdf; como `.bin` dispara will-download.
 *
 * Separado para poder ser testado sem abrir diálogo de impressão nenhum.
 */
export async function printablePath(
  filePath: string,
): Promise<{ path: string; cleanup: () => void }> {
  if (filePath.toLowerCase().endsWith('.pdf')) return { path: filePath, cleanup: () => {} }
  const copia = path.join(
    app.getPath('temp'),
    `orbit-print-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.pdf`,
  )
  await fsp.copyFile(filePath, copia)
  return {
    path: copia,
    // Só depois que o diálogo resolve: apagar antes tiraria o arquivo debaixo
    // do próprio visualizador que vai gerar as páginas.
    cleanup: () => void fsp.rm(copia, { force: true }).catch(() => {}),
  }
}

/** Rede de segurança: janela de impressão abandonada não fica para sempre. */
const PRINT_WINDOW_TTL_MS = 10 * 60_000

/**
 * Abre o diálogo de impressão do sistema para um arquivo.
 *
 * O documento é carregado numa janela com o visualizador embutido: é o
 * Chromium que sabe paginar um PDF para papel, e refazer isso a partir das
 * imagens que desenhamos daria um resultado pior justamente onde ele precisa
 * ser fiel.
 *
 * Duas decisões vieram de o botão ficar girando para sempre:
 *
 * 1. A janela é VISÍVEL. Com `show: false` o diálogo não tem onde se ancorar e
 *    fica esperando uma interação que ninguém consegue fazer. Medido: com
 *    `silent: true` (sem diálogo) o callback volta em ~1s mesmo oculta, então
 *    o que travava era o diálogo, não a impressão.
 * 2. A função retorna quando o diálogo ABRE, não quando a impressão termina.
 *    Esperar o fim é esperar o usuário — e era isso que mantinha a UI
 *    carregando. O resultado do trabalho quem reporta é o próprio diálogo.
 */
export async function printFile(
  filePath: string,
  title?: string,
): Promise<{ ok: boolean; error?: string }> {
  let alvo: { path: string; cleanup: () => void }
  try {
    alvo = await printablePath(filePath)
  } catch (err) {
    return { ok: false, error: `Não foi possível preparar o arquivo: ${(err as Error).message}` }
  }

  const win = new BrowserWindow({
    // Começa oculta e aparece depois de carregar, para não piscar em branco.
    show: false,
    width: 720,
    height: 860,
    // Filha da janela do app: fica por cima dela, some junto e não vira uma
    // segunda entrada solta na barra de tarefas.
    parent: BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
    title: title || path.basename(filePath),
    // Sem a barra de menu do Electron: esta janela existe só para hospedar o
    // diálogo, e um menu Arquivo/Editar/Exibir ali não leva a lugar nenhum.
    autoHideMenuBar: true,
    webPreferences: {
      // plugins: liga o visualizador de PDF embutido, sem o qual a janela
      // baixaria o arquivo em vez de renderizá-lo.
      plugins: true,
      partition: `doc-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  let encerrada = false
  const encerrar = () => {
    if (encerrada) return
    encerrada = true
    alvo.cleanup()
    if (!win.isDestroyed()) win.destroy()
  }

  // O visualizador de PDF renomeia a janela com o nome do ARQUIVO, que aqui é
  // a cópia temporária (`orbit-print-mu23….pdf`). Segurar o título mantém na
  // tela o nome do documento que o usuário mandou imprimir.
  win.setMenuBarVisibility(false)
  win.on('page-title-updated', (event) => event.preventDefault())

  try {
    await win.loadURL(pathToFileURL(alvo.path).toString())
  } catch (err) {
    encerrar()
    return { ok: false, error: (err as Error).message }
  }

  win.show()
  // Fechar a janela no meio é desistir de imprimir — e precisa limpar igual.
  win.on('closed', () => {
    encerrada = true
    alvo.cleanup()
  })
  win.webContents.print({ silent: false }, () => encerrar())
  setTimeout(encerrar, PRINT_WINDOW_TTL_MS)

  return { ok: true }
}

/**
 * Renderiza as páginas pedidas. `pages` é 1-indexado; páginas fora do
 * documento são ignoradas em silêncio (quem chama compara com `total`).
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
        const wantText = ${JSON.stringify(Boolean(options.includeText))}

        /** Itens de texto da página, em fração das dimensões dela. */
        const readItems = (items, viewport) => {
          const out = []
          for (const item of items) {
            const texto = item.str ?? ''
            if (!texto) continue
            const tx = pdfjs.Util.transform(viewport.transform, item.transform)
            const alturaGlifo = Math.hypot(tx[2], tx[3]) || (item.height ?? 0) * ${scale}
            out.push({
              x: tx[4] / viewport.width,
              y: (tx[5] - alturaGlifo) / viewport.height,
              width: ((item.width ?? 0) * ${scale}) / viewport.width,
              height: alturaGlifo / viewport.height,
              text: texto,
            })
            if (out.length > 4000) break
          }
          return out
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
    if (outcome === TIMED_OUT) throw new Error('tempo esgotado ao renderizar o PDF')

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
