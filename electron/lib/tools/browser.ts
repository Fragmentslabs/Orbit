import { tool } from 'ai'
import { BrowserWindow } from 'electron'
import { z } from 'zod'

/**
 * Ferramentas nativas de browser: o modelo controla uma janela oculta do
 * Electron para navegar, ler conteúdo renderizado (páginas com JavaScript)
 * e inspecionar links — indo além do webfetch estático.
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
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  })
  win.webContents.setAudioMuted(true)
  browserWindows.set(sessionId, win)
  return win
}

export function destroyBrowserWindow(sessionId: string) {
  const win = browserWindows.get(sessionId)
  if (win && !win.isDestroyed()) win.destroy()
  browserWindows.delete(sessionId)
}

async function navigate(sessionId: string, url: string): Promise<BrowserWindow> {
  const win = getBrowserWindow(sessionId)
  await win.loadURL(url).catch((err) => {
    // ERR_ABORTED acontece em redirects/SPAs; a página ainda carrega
    if (!(err instanceof Error) || !err.message.includes('ERR_ABORTED')) throw err
  })
  await new Promise((r) => setTimeout(r, 1000)) // aguarda hidratação de SPAs
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
      'Abre uma URL em um browser real (com JavaScript) e retorna o texto renderizado da página. Prefira esta ferramenta para páginas dinâmicas.',
    inputSchema: z.object({
      url: z.string().describe('URL para abrir'),
    }),
    execute: async ({ url }) => {
      const win = await Promise.race([
        navigate(sessionId, url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Tempo de navegação esgotado')), NAVIGATION_TIMEOUT),
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
    description: 'Lista os links da página atualmente aberta no browser.',
    inputSchema: z.object({}),
    execute: async () => {
      const win = browserWindows.get(sessionId)
      if (!win || win.isDestroyed()) return 'Nenhuma página aberta. Use browser_open primeiro.'
      const links = (await win.webContents.executeJavaScript(EXTRACT_LINKS)) as {
        text: string
        href: string
      }[]
      if (links.length === 0) return 'Nenhum link encontrado na página.'
      return links.map((l) => `- [${l.text}](${l.href})`).join('\n')
    },
  })
}
