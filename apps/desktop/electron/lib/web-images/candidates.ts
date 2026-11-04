import { createHash } from 'node:crypto'
import { isSafeImageUrl } from '../image-search/download'

/**
 * Candidates for "show this image from the web": what the page's own HTML says
 * about its images. Pure (no Electron, no network) so the filtering rules — which
 * are where this feature gets noisy — are testable.
 */

export interface RawImage {
  /** Address of the image as the page wrote it (maybe relative) */
  src: string
  /** Address of the page/post the image links to, when it sits inside a link */
  href?: string
  alt?: string
  /** Smaller copy served by the search engine itself (it never refuses hotlinks) */
  thumb?: string
  /** Rendered size on the page, in px */
  width?: number
  height?: number
}

export interface WebImageCandidate {
  /** Short id the agent uses: `web:<10 hex>` */
  id: string
  imageUrl: string
  pageUrl: string
  host: string
  title: string
  /** Alternative address when the site refuses to serve `imageUrl` to us */
  fallbackUrl?: string
  width?: number
  height?: number
}

const MIN_SIDE = 120
/** Patterns of what is chrome, not content: logos, avatars, sprites, tracking pixels. */
const NOISE = /(?:^|[/_.-])(?:logo|icon|favicon|sprite|avatar|badge|emoji|pixel|spacer|blank|placeholder|loading|spinner)(?:[/_.\-@]|\d|$)/i

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function candidateId(imageUrl: string): string {
  return `web:${createHash('sha1').update(imageUrl).digest('hex').slice(0, 10)}`
}

function absolute(raw: string | undefined, base: string): string | null {
  if (!raw) return null
  try {
    return new URL(raw, base).toString()
  } catch {
    return null
  }
}

/** Turns what the page scripts returned into candidates: absolute https URLs, no noise, no repeats. */
export function toCandidates(raw: RawImage[], pageUrl: string, limit = 24): WebImageCandidate[] {
  const seen = new Set<string>()
  const out: WebImageCandidate[] = []
  for (const item of raw) {
    const imageUrl = absolute(item.src, pageUrl)
    if (!imageUrl || !isSafeImageUrl(imageUrl)) continue
    if (/\.(svg|ico)(\?|#|$)/i.test(imageUrl) || NOISE.test(new URL(imageUrl).pathname)) continue
    // The size the page renders is the signal that it is content; the unknown passes.
    if ((item.width !== undefined && item.width < MIN_SIDE) || (item.height !== undefined && item.height < MIN_SIDE)) continue
    if (seen.has(imageUrl)) continue
    seen.add(imageUrl)
    const linked = absolute(item.href, pageUrl)
    const page = linked && /^https?:/.test(linked) ? linked : pageUrl
    out.push({
      id: candidateId(imageUrl),
      imageUrl,
      pageUrl: page,
      host: hostOf(page),
      title: (item.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
      ...(item.thumb && isSafeImageUrl(item.thumb) ? { fallbackUrl: item.thumb } : {}),
      ...(item.width && item.height ? { width: item.width, height: item.height } : {}),
    })
    if (out.length >= limit) break
  }
  return out
}

// ─── Where the search goes ───────────────────────────────────────────────────

export type WebImageSite = 'any' | 'dribbble' | 'behance' | 'pinterest'

/** The page a search opens. Everything but `any` is that site's own search page. */
export function searchPageUrl(query: string, site: WebImageSite): string {
  const q = encodeURIComponent(query.trim())
  switch (site) {
    case 'dribbble':
      return `https://dribbble.com/search/${encodeURIComponent(query.trim().replace(/\s+/g, '-'))}`
    case 'behance':
      return `https://www.behance.net/search/projects?search=${q}`
    case 'pinterest':
      return `https://www.pinterest.com/search/pins/?q=${q}`
    default:
      return `https://www.bing.com/images/search?q=${q}&form=HDRSC3&first=1`
  }
}

// ─── Memory of the last searches ─────────────────────────────────────────────

const TTL_MS = 2 * 60 * 60 * 1000
const MAX_ENTRIES = 800
const entries = new Map<string, { item: WebImageCandidate; at: number }>()

export function rememberCandidates(items: WebImageCandidate[], now = Date.now()): void {
  for (const item of items) {
    entries.delete(item.id)
    entries.set(item.id, { item, at: now })
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export function recallCandidate(id: string, now = Date.now()): WebImageCandidate | null {
  const hit = entries.get(id.trim())
  if (!hit) return null
  if (now - hit.at > TTL_MS) {
    entries.delete(id.trim())
    return null
  }
  return hit.item
}

export function clearCandidates(): void {
  entries.clear()
}
