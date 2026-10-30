import { BrowserWindow } from 'electron'
import path from 'node:path'
import sharp from 'sharp'
import { saveMotionMedia, setMediaDeleteHook } from '../media'
import { MOTION_SPEC } from './motion-runtime'
import { capturePageReliably } from './capture'
import { deleteMotionComposition, getMotion, registeredMotionUrl } from './motion-store'

/**
 * The COVER of a motion piece, and its registration in the gallery.
 *
 * It is what turns the composition into something that is reopened later: without this the piece
 * only existed while the panel's tab was open — close it, and there was no
 * place to click to come back, because nothing listed it. The composition itself keeps
 * where it always was (a project folder, with the record in `motion.json`); what
 * comes into existence is an item in the gallery pointing at it.
 *
 * The thumbnail comes out of the SAME offscreen window that measures the layers (the
 * `orbit-motion://` scheme, in the default session, is what serves the composition), with a seek
 * to a single frame — cheaper than a video, and enough for the tile.
 */

/** At what point of the piece the cover is taken, as a fraction of the duration.
 *  Not frame 0: the opening of a piece is usually black or nearly so, and the
 *  cover would be empty. A bit past the middle catches the piece in motion. */
const COVER_AT = 0.6
/** Width of the stored cover — the same tile size as artifacts. */
const COVER_WIDTH = 640
const LOAD_TIMEOUT_MS = 20000

interface CoverShot {
  png: Buffer
  width: number
  height: number
}

/**
 * Loads the composition offscreen and photographs one frame of it.
 *
 * Best-effort all the way: any failure returns `null` and the piece enters the
 * gallery without a cover (the tile falls back to the icon, exactly like an artifact whose
 * capture failed). Registering the piece can never depend on the capture working.
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
    // The frame must be photographed at the composition's size: a
    // different viewport catches the layout differently (the same care as the render).
    win.setContentSize(width, height)
    const total = spec.durationInFrames ?? 0
    const frame = total > 0 ? Math.min(total - 1, Math.round(total * COVER_AT)) : 0
    // A seek is a pure function of the frame number (it is the same contract as the render);
    // the `catch` is because the composition may not expose `seek`, and then the cover comes out of the
    // scene that happens to be mounted.
    await win.webContents
      .executeJavaScript(`window.orbitMotion && window.orbitMotion.seek(${frame})`, true)
      .catch(() => {})
    // One frame for Chromium to paint after the seek.
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
 * Puts (or updates) the piece in the gallery, with the cover taken now.
 *
 * Returns the registered item, or `null` if the composition is no longer in the
 * registry. Idempotent: registering the same piece again lands on the SAME item — it is the
 * `motionId` that rules, not the moment.
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
    title: opts.title ?? (entry ? path.basename(entry.folder) : 'Piece'),
    // The working folder that registered the piece is its project — it is through here that
    // Media groups, and it is what makes the item survive the conversation that created it.
    directory: entry?.root,
    sessionId: opts.sessionId ?? entry?.sessionId,
    width: shot?.width,
    height: shot?.height,
  })
  return true
}

// Deleting the piece in the gallery really deletes the composition (the folder, the record and
// the watcher), and not only the cover: deleting is freeing space. The safety
// locks stay in deleteMotionComposition.
setMediaDeleteHook('motion', async (entry) => {
  if (entry.motionId) await deleteMotionComposition(entry.motionId)
})
