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
 * A CAPA de um deck e o registro dele na galeria — espelha design-gallery.ts.
 *
 * A miniatura é o PRIMEIRO slide, e sai de graça: o deck é servido pelo
 * `orbit-slides://` com o runtime injetado, que monta o palco e mostra o slide
 * 1. Fotografar uma janela do tamanho do palco dá exatamente a capa — sem seek,
 * sem medição de camada, sem segunda fonte de verdade para o layout.
 *
 * A janela precisa ter o tamanho EXATO declarado no meta do deck: é isso que
 * faz o runtime escalar em 1:1 e a captura sair sem tarja.
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
    // Sem isto o Chromium não pinta uma janela nunca exibida.
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
    // Um instante para o runtime montar o palco e o Chromium terminar de pintar.
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
 * Põe (ou atualiza) o deck na galeria, com a capa tirada agora. Idempotente:
 * registrar o mesmo deck de novo cai no MESMO item — é o `slidesId` que manda,
 * não o momento.
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

// Excluir o deck na galeria apaga o de verdade (a pasta, o registro e o
// watcher) — excluir é liberar espaço. As travas de segurança ficam em
// deleteSlidesDeck: o projeto em si nunca é apagado.
setMediaDeleteHook('slides', async (entry) => {
  if (entry.slidesId) await deleteSlidesDeck(entry.slidesId)
})
