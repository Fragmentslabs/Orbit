import { parseCommons, matchesLicense, parseOpenverse } from './providers'
import type { Fetcher, ImageProvider, ImageResult, Orientation, SearchOptions, SearchOutcome } from './types'

/**
 * The search itself: it builds each provider's request, joins and filters what comes
 * back.
 *
 * Both providers answer without a key. Openverse limits anonymous use (20 requests
 * per minute, 200 per day per IP), so a 429 becomes a WARNING, not an error: the
 * search goes on with what the other provider brought.
 */

/** Who is asking: Wikimedia asks for a User-Agent that says which app it is. */
export const USER_AGENT = 'Orbit/1.0 (desktop app; image search for video projects)'

const COMMONS_ENDPOINT = 'https://commons.wikimedia.org/w/api.php'
const OPENVERSE_ENDPOINT = 'https://api.openverse.org/v1/images/'
/** Openverse takes up to ~15 s on a search that is not cached. */
const REQUEST_TIMEOUT_MS = 25_000
/** Once a provider has brought results, the slower one gets only this window. */
export const GRACE_MS = 6_000
/** Width of the file requested from Commons: enough for a 1080p frame without bringing the 60 MP original. */
const COMMONS_WIDTH = 1920

export const MAX_RESULTS = 12

export function commonsUrl(opts: SearchOptions): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    // `filetype:bitmap` leaves SVG, PDF and audio out — only images a video can use.
    gsrsearch: `${opts.query} filetype:bitmap`,
    gsrnamespace: '6',
    // Asks for more than needed: the size and license filter discards part of it.
    gsrlimit: String(Math.min(50, opts.limit * 3)),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(COMMONS_WIDTH),
    origin: '*',
  })
  return `${COMMONS_ENDPOINT}?${params}`
}

export function openverseUrl(opts: SearchOptions): string {
  const params = new URLSearchParams({
    q: opts.query,
    // Openverse anonymous access refuses (401) a page_size above 20.
    page_size: String(Math.min(20, opts.limit * 3)),
    mature: 'false',
  })
  if (opts.license === 'public-domain') params.set('license', 'cc0,pdm')
  else if (opts.license === 'commercial') params.set('license_type', 'commercial')
  if (opts.orientation === 'landscape') params.set('aspect_ratio', 'wide')
  else if (opts.orientation === 'portrait') params.set('aspect_ratio', 'tall')
  else if (opts.orientation === 'square') params.set('aspect_ratio', 'square')
  return `${OPENVERSE_ENDPOINT}?${params}`
}

function orientationOf(width: number, height: number): Orientation {
  const ratio = width / height
  if (ratio > 1.15) return 'landscape'
  if (ratio < 0.87) return 'portrait'
  return 'square'
}

/** Does the result fit what was asked (size, orientation, license)? */
export function acceptable(result: ImageResult, opts: SearchOptions): boolean {
  if (!matchesLicense(result.credit.license, opts.license)) return false
  if (result.width !== undefined && result.width < opts.minWidth) return false
  if (opts.orientation && result.width && result.height && orientationOf(result.width, result.height) !== opts.orientation) return false
  return true
}

/** Interleaves the providers (1st of one, 1st of the other…): none dominates the list. */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = []
  const longest = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < longest; i += 1) for (const list of lists) if (i < list.length) out.push(list[i])
  return out
}

async function getJson(fetcher: Fetcher, url: string): Promise<{ json?: unknown; status: number }> {
  const res = await fetcher(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) return { status: res.status }
  return { json: await res.json(), status: res.status }
}

const LABEL: Record<ImageProvider, string> = { commons: 'Wikimedia Commons', openverse: 'Openverse' }

async function fromProvider(provider: ImageProvider, opts: SearchOptions, fetcher: Fetcher): Promise<{ results: ImageResult[]; warning?: string }> {
  try {
    const { json, status } = await getJson(fetcher, provider === 'commons' ? commonsUrl(opts) : openverseUrl(opts))
    if (json === undefined) {
      return {
        results: [],
        warning: status === 429 ? `${LABEL[provider]}: rate limit reached — try again in a minute` : `${LABEL[provider]}: request failed (${status})`,
      }
    }
    return { results: provider === 'commons' ? parseCommons(json) : parseOpenverse(json) }
  } catch (err) {
    return { results: [], warning: `${LABEL[provider]}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Waits for the providers, but without letting the slowest one hold the answer: once
 * one has brought results, the others have `graceMs` to arrive. Those that did not
 * arrive become a warning — the partial search still serves, and the agent can
 * repeat it.
 */
async function gather(
  providers: ImageProvider[],
  opts: SearchOptions,
  fetcher: Fetcher,
  graceMs: number,
): Promise<Array<{ results: ImageResult[]; warning?: string }>> {
  const slots: Array<{ results: ImageResult[]; warning?: string } | undefined> = providers.map(() => undefined)
  const pending = providers.map((p, i) =>
    fromProvider(p, opts, fetcher).then((outcome) => {
      slots[i] = outcome
    }),
  )
  const first = new Promise<void>((resolve) => {
    for (const job of pending) {
      void job.then(() => {
        if (slots.some((s) => s && s.results.length > 0)) resolve()
      })
    }
  })
  const all = Promise.all(pending).then(() => undefined)
  await Promise.race([all, first.then(() => new Promise<void>((resolve) => setTimeout(resolve, graceMs)))])
  // Those that have not answered yet come in as a warning (the request goes on and expires on its own).
  return slots.map((slot, i) => slot ?? { results: [], warning: `${LABEL[providers[i]]}: too slow — repeat the search to include it` })
}

export async function searchImages(opts: SearchOptions, fetcher: Fetcher = fetch, graceMs = GRACE_MS): Promise<SearchOutcome> {
  const settled = await gather(opts.providers, opts, fetcher, graceMs)
  const warnings = settled.flatMap((s) => (s.warning ? [s.warning] : []))
  const lists = settled.map((s) => s.results.filter((r) => acceptable(r, opts)))
  const seen = new Set<string>()
  const results: ImageResult[] = []
  for (const result of interleave(lists)) {
    // The same file usually comes from both (Openverse indexes Commons).
    const key = result.credit.sourceUrl
    if (seen.has(key)) continue
    seen.add(key)
    results.push(result)
    if (results.length >= opts.limit) break
  }
  return { results, warnings }
}
