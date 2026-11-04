import { tool } from 'ai'
import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { WEB_PARTITION } from '../web-images/store'

/**
 * Native browser tools: the model controls a hidden Electron window to navigate,
 * read rendered content (pages with JavaScript)
 * and inspect links — going beyond the static webfetch.
 */

const NAVIGATION_TIMEOUT = 30_000
const browserWindows = new Map<string, BrowserWindow>()

function getBrowserWindow(sessionId: string): BrowserWindow {
  const existing = browserWindows.get(sessionId)
  if (existing && !existing.isDestroyed()) return existing

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    // Its own persistent session: a login the user makes once (Pinterest, Behance) stays.
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, partition: WEB_PARTITION },
  })
  win.webContents.setAudioMuted(true)
  browserWindows.set(sessionId, win)
  return win
}

/** The window this session already opened, if any (never creates one). */
export function openBrowserWindow(sessionId: string): BrowserWindow | null {
  const win = browserWindows.get(sessionId)
  return win && !win.isDestroyed() ? win : null
}

export function destroyBrowserWindow(sessionId: string) {
  const win = browserWindows.get(sessionId)
  if (win && !win.isDestroyed()) win.destroy()
  browserWindows.delete(sessionId)
}

export async function navigate(sessionId: string, url: string): Promise<BrowserWindow> {
  const win = getBrowserWindow(sessionId)
  await win.loadURL(url).catch((err) => {
    // ERR_ABORTED happens on redirects/SPAs; the page still loads
    if (!(err instanceof Error) || !err.message.includes('ERR_ABORTED')) throw err
  })
  await new Promise((r) => setTimeout(r, 1000)) // waits for SPA hydration
  return win
}

const EXTRACT_TEXT = `
  (() => {
    const clone = document.body.cloneNode(true)
    clone.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove())
    return { title: document.title, url: location.href, text: clone.innerText }
  })()
`

const EXTRACT_LINKS = `
  Array.from(document.querySelectorAll('a[href]'))
    .map((a) => ({ text: a.innerText.trim().slice(0, 120), href: a.href }))
    .filter((l) => l.text && l.href.startsWith('http'))
    .slice(0, 100)
`

export function createBrowserOpenTool(sessionId: string) {
  return tool({
    description:
      'Opens a URL in a real browser (with JavaScript) and returns the page\'s rendered text. Prefer this tool for dynamic pages.',
    inputSchema: z.object({
      url: z.string().describe('URL to open'),
    }),
    execute: async ({ url }) => {
      const win = await Promise.race([
        navigate(sessionId, url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Navigation timed out')), NAVIGATION_TIMEOUT),
        ),
      ])
      const page = (await win.webContents.executeJavaScript(EXTRACT_TEXT)) as {
        title: string
        url: string
        text: string
      }
      return `# ${page.title}\nURL: ${page.url}\n\n${page.text.slice(0, 80_000)}`
    },
  })
}

export function createBrowserLinksTool(sessionId: string) {
  return tool({
    description: 'Lists the links on the page currently open in the browser.',
    inputSchema: z.object({}),
    execute: async () => {
      const win = browserWindows.get(sessionId)
      if (!win || win.isDestroyed()) return 'No page open. Use browser_open first.'
      const links = (await win.webContents.executeJavaScript(EXTRACT_LINKS)) as {
        text: string
        href: string
      }[]
      if (links.length === 0) return 'No links found on the page.'
      return links.map((l) => `- [${l.text}](${l.href})`).join('\n')
    },
  })
}
