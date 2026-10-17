import { BrowserWindow } from 'electron'
import path from 'node:path'
import sharp from 'sharp'
import { saveMotionMedia, setMediaDeleteHook } from '../media'
import { MOTION_SPEC } from './motion-runtime'
import { capturePageReliably } from './capture'
import { deleteMotionComposition, getMotion, registeredMotionUrl } from './motion-store'

/**
 * A CAPA de uma peça de motion, e o registro dela na galeria.
 *
 * É o que transforma a composição em algo que se reabre depois: sem isto a peça
 * só existia enquanto a aba do painel estivesse aberta — fechou, e não havia
 * onde clicar para voltar, porque nada a listava. A composição em si continua
 * onde sempre esteve (uma pasta do projeto, com o registro em `motion.json`); o
 * que passa a existir é um item na galeria apontando para ela.
 *
 * A miniatura sai da MESMA janela offscreen que mede as camadas (o scheme
 * `orbit-motion://`, no session default, é quem serve a composição), com um seek
 * a um quadro só — mais barato que um vídeo, e suficiente para o tile.
 */

/** Em que ponto da peça a capa é tirada, em fração da duração.
 *  Não é o quadro 0: a abertura de uma peça costuma ser preta ou quase, e a
 *  capa ficaria vazia. Um pouco além da metade pega a peça em movimento. */
const COVER_AT = 0.6
/** Largura da capa gravada — o mesmo tamanho de tile dos artefatos. */
const COVER_WIDTH = 640
const LOAD_TIMEOUT_MS = 20000

interface CoverShot {
  png: Buffer
  width: number
  height: number
}

/**
 * Carrega a composição offscreen e fotografa um quadro dela.
 *
 * Best-effort por inteiro: qualquer falha devolve `null` e a peça entra na
 * galeria sem capa (o tile cai no ícone, exatamente como um artefato cuja
 * captura falhou). Registrar a peça nunca pode depender de a captura dar certo.
 */
async function captureCover(url: string): Promise<CoverShot | null> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    frame: false,
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
    await win.loadURL(url)
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
    const spec = (await win.webContents.executeJavaScript(MOTION_SPEC, true)) as {
      width?: number
      height?: number
      fps?: number
      durationInFrames?: number
    } | null
    if (!spec) return null
    const width = Math.round(spec.width ?? 1920)
    const height = Math.round(spec.height ?? 1080)
    // O quadro tem de ser fotografado no tamanho da composição: um viewport
    // diferente pega o layout de outro jeito (o mesmo cuidado do render).
    win.setContentSize(width, height)
    const total = spec.durationInFrames ?? 0
    const frame = total > 0 ? Math.min(total - 1, Math.round(total * COVER_AT)) : 0
    // Um seek é função pura do número do quadro (é o mesmo contrato do render);
    // o `catch` é porque a composição pode não expor `seek`, e aí a capa sai da
    // cena que estiver montada.
    await win.webContents
      .executeJavaScript(`window.orbitMotion && window.orbitMotion.seek(${frame})`, true)
      .catch(() => {})
    // Um quadro para o Chromium pintar depois do seek.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const image = await capturePageReliably(win.webContents)
    const png = await sharp(image.toPNG())
      .resize({ width: COVER_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer()
    return { png, width, height }
  } finally {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * Põe (ou atualiza) a peça na galeria, com a capa tirada agora.
 *
 * Devolve o item registrado, ou `null` se a composição não está mais no
 * registro. Idempotente: registrar a mesma peça de novo cai no MESMO item — é o
 * `motionId` que manda, não o momento.
 */
export async function registerMotionCover(
  id: string,
  opts: { title?: string; sessionId?: string } = {},
): Promise<boolean> {
  const url = await registeredMotionUrl(id)
  if (!url) return false
  const entry = await getMotion(id)
  const shot = await captureCover(url).catch(() => null)
  await saveMotionMedia(shot?.png ?? null, {
    motionId: id,
    title: opts.title ?? (entry ? path.basename(entry.folder) : 'Peça'),
    // A pasta de trabalho que registrou a peça é o projeto dela — é por aqui que
    // a Mídia agrupa, e é o que faz o item sobreviver à conversa que o criou.
    directory: entry?.root,
    sessionId: opts.sessionId ?? entry?.sessionId,
    width: shot?.width,
    height: shot?.height,
  })
  return true
}

// Excluir a peça na galeria apaga a composição de verdade (a pasta, o registro e
// o watcher), e não só a capa: excluir é liberar espaço. As travas de segurança
// ficam em deleteMotionComposition.
setMediaDeleteHook('motion', async (entry) => {
  if (entry.motionId) await deleteMotionComposition(entry.motionId)
})
