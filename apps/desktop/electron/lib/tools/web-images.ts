import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ImageSource } from '@shared/chat'
import { buildContactSheet, MAX_SHEET_CELLS } from '../image-search/sheet'
import {
  recallCandidate,
  rememberCandidates,
  searchPageUrl,
  toCandidates,
  type RawImage,
  type WebImageCandidate,
  type WebImageSite,
} from '../web-images/candidates'
import { EXTRACT_BING_IMAGES, EXTRACT_PAGE_IMAGES, SCROLL_PAGE } from '../web-images/extract-script'
import { cacheWebImage, webSession } from '../web-images/store'
import { navigate, openBrowserWindow } from './browser'

/**
 * Pictures from the open web, shown in the chat — the way a person would look for
 * references (Dribbble, Behance, Pinterest, any page). No API: the hidden browser
 * opens the search page and reads what rendered.
 *
 * The agent SEARCHES (or reads the open page), looks at a sheet of thumbnails and
 * SHOWS the ones it chose. Showing is not importing: the picture lives in a cache,
 * carries the address of the page it came from, and is not in the gallery — so
 * nothing downstream (a video, a piece) picks it up by accident. These are other
 * people's work: references to look at, not material to publish.
 */

const NAV_TIMEOUT_MS = 30_000
const MAX_LISTED = 16
const MAX_SHOW = 8
const sheetStash = new Map<string, string>()

const SITES = ['any', 'dribbble', 'behance', 'pinterest'] as const

async function runInPage<T>(sessionId: string, script: string): Promise<T> {
  const win = openBrowserWindow(sessionId)
  if (!win) throw new Error('No page open.')
  return (await win.webContents.executeJavaScript(script)) as T
}

function line(c: WebImageCandidate, n: number): string {
  const size = c.width && c.height ? ` · ${c.width}x${c.height}` : ''
  return `${n}. ${c.id} — "${c.title || 'untitled'}" · ${c.host}${size}`
}

/** A fetcher for the contact sheet: thumbnails go out with the page as Referer, like the real ones. */
function sheetFetcher(items: WebImageCandidate[]) {
  const referer = new Map(items.map((c) => [c.fallbackUrl ?? c.imageUrl, c.pageUrl]))
  return (url: string, init?: RequestInit) => {
    const ref = referer.get(url)
    return webSession().fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...(ref ? { Referer: ref } : {}) } })
  }
}

async function report(
  items: WebImageCandidate[],
  header: string,
  scope: { modelVision: boolean },
  toolCallId: string,
): Promise<string> {
  rememberCandidates(items)
  if (scope.modelVision) {
    const shown = items.slice(0, MAX_SHEET_CELLS)
    const sheet = await buildContactSheet(
      shown.map((c) => ({ thumbUrl: c.fallbackUrl ?? c.imageUrl })),
      sheetFetcher(shown),
    )
    if (sheet) sheetStash.set(toolCallId, sheet.toString('base64'))
  }
  return [
    header,
    ...items.map((c, i) => line(c, i + 1)),
    scope.modelVision
      ? `The sheet shows the first ${Math.min(items.length, MAX_SHEET_CELLS)} in this order. Pick the ones that fit, then call web_image_show with their ids.`
      : 'You cannot see the thumbnails: choose from the titles and say so if the match is uncertain. Then call web_image_show with the ids.',
  ].join('\n')
}

function withSheet(toolCallId: string, output: unknown) {
  const sheet = sheetStash.get(toolCallId)
  sheetStash.delete(toolCallId)
  if (!sheet) return { type: 'text' as const, value: String(output) }
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: String(output) },
      { type: 'image-data' as const, data: sheet, mediaType: 'image/webp' },
    ],
  }
}

export function createWebImageTools(scope: { sessionId: string; modelVision: boolean }): ToolSet {
  return {
    web_image_search: tool({
      description:
        'Looks for pictures on the web the way a person would — to show REFERENCES to the user (design inspiration, a person, a place, a product, a style). ' +
        'site: "any" (a web image search, default), or "dribbble", "behance", "pinterest" to search that site for design references. ' +
        'Returns candidates with the page each one comes from, plus a numbered sheet of thumbnails so you CHOOSE by looking. Then call web_image_show with the ids you chose. ' +
        'These are other people\'s work: they are shown to the user as references and are NOT imported into the app — never use them in a published piece, a video or a deliverable; if the user asks for that, warn about the copyright first.',
      inputSchema: z.object({
        query: z.string().min(2).describe('What to look for, e.g. "fintech dashboard dark ui" or "Kendrick Lamar live"'),
        site: z.enum(SITES).optional(),
        count: z.number().int().min(1).max(MAX_LISTED).optional().describe('How many candidates (default 8)'),
      }),
      execute: async ({ query, site = 'any', count = 8 }, { toolCallId }) => {
        const url = searchPageUrl(query, site as WebImageSite)
        await Promise.race([
          navigate(scope.sessionId, url),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Navigation timed out')), NAV_TIMEOUT_MS)),
        ])
        await new Promise((r) => setTimeout(r, 1500))
        let raw: RawImage[] = []
        if (site === 'any') raw = await runInPage<RawImage[]>(scope.sessionId, EXTRACT_BING_IMAGES)
        if (raw.length === 0) {
          await runInPage(scope.sessionId, SCROLL_PAGE).catch(() => undefined)
          raw = await runInPage<RawImage[]>(scope.sessionId, EXTRACT_PAGE_IMAGES)
        }
        const items = toCandidates(raw, url, count)
        if (items.length === 0) {
          return [
            `No pictures found for "${query}"${site === 'any' ? '' : ` on ${site}`}.`,
            'The page may be asking for a login or a human check — tell the user instead of trying to get around it (they can sign in on the site once and it will be remembered), or try other words or another site.',
          ].join('\n')
        }
        return report(items, `${items.length} picture(s) for "${query}"${site === 'any' ? '' : ` on ${site}`}:`, scope, toolCallId)
      },
      toModelOutput: ({ toolCallId, output }) => withSheet(toolCallId, output),
    }),

    browser_images: tool({
      description:
        'Lists the pictures on the page currently open in the browser (opened with browser_open), with the page each one links to, plus a sheet of thumbnails. ' +
        'Use it when the user pointed you at a page (a Dribbble shot, a Behance project, an article) and wants to see its images. Then call web_image_show with the ids you chose.',
      inputSchema: z.object({
        count: z.number().int().min(1).max(MAX_LISTED).optional().describe('How many (default 12)'),
      }),
      execute: async ({ count = 12 }, { toolCallId }) => {
        const win = openBrowserWindow(scope.sessionId)
        if (!win) return 'No page open. Use browser_open first.'
        await runInPage(scope.sessionId, SCROLL_PAGE).catch(() => undefined)
        const raw = await runInPage<RawImage[]>(scope.sessionId, EXTRACT_PAGE_IMAGES)
        const items = toCandidates(raw, win.webContents.getURL(), count)
        if (items.length === 0) return 'No usable pictures on this page.'
        return report(items, `${items.length} picture(s) on ${win.webContents.getURL()}:`, scope, toolCallId)
      },
      toModelOutput: ({ toolCallId, output }) => withSheet(toolCallId, output),
    }),

    web_image_show: tool({
      description:
        'Shows pictures from web_image_search / browser_images IN YOUR REPLY, as a grid the user can open. Each one keeps the address of the page it came from, which the viewer displays. ' +
        'They appear on their own — do NOT also write markdown ![](…) (the chat blocks it). Refer to them by number or title and mention the source. ' +
        'They are references and are not saved to the app.',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(MAX_SHOW).describe('Ids from web_image_search (web:…)'),
      }),
      execute: async ({ ids }) => {
        const lines: string[] = []
        const images: Array<{ src: string; alt: string; source: ImageSource }> = []
        for (const id of ids) {
          const candidate = recallCandidate(id)
          if (!candidate) {
            lines.push(`${id}: not in the last results (they expire) — search again.`)
            continue
          }
          try {
            const cached = await cacheWebImage(candidate)
            images.push({
              src: cached.src,
              alt: candidate.title,
              source: { pageUrl: candidate.pageUrl, imageUrl: candidate.imageUrl, host: candidate.host, title: candidate.title || undefined },
            })
            lines.push(`${id}: shown · ${cached.width}x${cached.height} · from ${candidate.host} (${candidate.pageUrl})`)
          } catch (err) {
            lines.push(`${id}: could not be loaded — ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        lines.push(
          images.length > 0
            ? 'The pictures already appear in your reply. Say where they come from (the site) and, if the user may use them for something beyond looking, remind them they are other people\'s work.'
            : 'Nothing was shown.',
        )
        return { message: lines.join('\n'), images }
      },
      toModelOutput: ({ output }) => ({ type: 'text', value: typeof output === 'string' ? output : (output as { message: string }).message }),
    }),
  }
}
