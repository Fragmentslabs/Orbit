import { BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { dataDir } from '../storage'
import { getFragment } from './fragment-store'

/**
 * The cover of a fragment on the phone's list: a picture of the page itself, taken once per revision
 * and theme and served as a plain image, so the phone keeps it in its own cache and draws a list
 * without running a web view per card. The desktop takes it the way it takes a design's cover — an
 * offscreen window — but loads the same host page the phone does, in `cover` mode, where the page may
 * read what it stored (a dashboard looks like itself) and nothing else.
 */

export type CoverTheme = 'dark' | 'light'

/** What the phone lays the page out at; the picture is a phone-sized top of the page. */
const PAGE_WIDTH = 390
const PAGE_HEIGHT = 520
const PICTURE_WIDTH = 480
const READY_TIMEOUT_MS = 12_000
export const COVER_READY_TITLE = 'orbit-cover-ready'

export const COVER_FILE_RE = /^__orbit-cover-(dark|light)\.png$/

function coversDir(): string {
  return path.join(dataDir(), 'fragment-covers')
}

export function coverFile(id: string, revision: number, theme: CoverTheme): string {
  return path.join(coversDir(), `${id}-r${revision}-${theme}.png`)
}

const inflight = new Map<string, Promise<string | null>>()

/** One picture at a time: each is a hidden browser window, and a list asks for many at once. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * The file of the cover for the fragment's CURRENT revision, taken now when there is none yet.
 * `url` is the host page's address on this machine (the signed one, loopback). null when it could
 * not be taken (the page never settled, no window): the phone keeps the icon.
 */
export async function ensureFragmentCover(id: string, theme: CoverTheme, url: string): Promise<string | null> {
  const manifest = await getFragment(id)
  if (!manifest) return null
  const file = coverFile(id, manifest.revision, theme)
  if (await fsp.stat(file).then((s) => s.isFile(), () => false)) return file
  const key = path.basename(file)
  const pending = inflight.get(key)
  if (pending) return pending
  const job = queue
    .then(() => capture(url, theme))
    .then(async (png) => {
      if (!png) return null
      await fsp.mkdir(coversDir(), { recursive: true })
      await fsp.writeFile(file, png)
      await dropOldCovers(id, manifest.revision)
      return file
    })
    .catch(() => null)
    .finally(() => inflight.delete(key))
  inflight.set(key, job)
  queue = job
  return job
}

/** A new revision makes the older pictures of that fragment useless. */
async function dropOldCovers(id: string, revision: number): Promise<void> {
  const names = await fsp.readdir(coversDir()).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((name) => name.startsWith(`${id}-r`) && !name.startsWith(`${id}-r${revision}-`))
      .map((name) => fsp.rm(path.join(coversDir(), name), { force: true })),
  )
}

async function capture(url: string, theme: CoverTheme): Promise<Buffer | null> {
  const win = new BrowserWindow({
    show: false,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    frame: false,
    useContentSize: true,
    backgroundColor: theme === 'dark' ? '#0a0a0c' : '#ffffff',
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await win.loadURL(`${url}${url.includes('?') ? '&' : '?'}cover=1&theme=${theme}`)
    const started = Date.now()
    // The host page says it settled by changing its title (the iframe loaded, its reads were answered).
    while (Date.now() - started < READY_TIMEOUT_MS) {
      if (win.isDestroyed()) return null
      if (win.webContents.getTitle() === COVER_READY_TITLE) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (win.webContents.getTitle() !== COVER_READY_TITLE) return null
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    if (png.length === 0) return null
    return await sharp(png).resize({ width: PICTURE_WIDTH, withoutEnlargement: true }).png().toBuffer()
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
