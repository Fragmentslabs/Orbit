import { parseCommons, matchesLicense, parseOpenverse } from './providers'
import type { Fetcher, ImageProvider, ImageResult, Orientation, SearchOptions, SearchOutcome } from './types'

/**
 * A busca em si: monta o pedido de cada provedor, junta e filtra o que volta.
 *
 * Os dois provedores respondem sem chave. O Openverse limita o uso anônimo (20
 * pedidos por minuto, 200 por dia por IP), então um 429 vira um AVISO, e não um
 * erro: a busca segue com o que o outro provedor trouxe.
 */

/** Quem pergunta: a Wikimedia pede um User-Agent que diga quem é o app. */
export const USER_AGENT = 'Orbit/1.0 (desktop app; image search for video projects)'

const COMMONS_ENDPOINT = 'https://commons.wikimedia.org/w/api.php'
const OPENVERSE_ENDPOINT = 'https://api.openverse.org/v1/images/'
/** O Openverse leva até ~15 s numa busca que não está em cache. */
const REQUEST_TIMEOUT_MS = 25_000
/** Depois que um provedor já trouxe resultados, o mais lento ganha só esta janela. */
export const GRACE_MS = 6_000
/** Largura do arquivo pedido ao Commons: sobra para um quadro de 1080p sem trazer o original de 60 MP. */
const COMMONS_WIDTH = 1920

export const MAX_RESULTS = 12

export function commonsUrl(opts: SearchOptions): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    // `filetype:bitmap` deixa de fora SVG, PDF e áudio — só imagem que um vídeo usa.
    gsrsearch: `${opts.query} filetype:bitmap`,
    gsrnamespace: '6',
    // Pede mais do que o necessário: o filtro de tamanho e licença descarta parte.
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
    // O acesso anônimo do Openverse recusa (401) page_size acima de 20.
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

/** O resultado cabe no que foi pedido (tamanho, orientação, licença)? */
export function acceptable(result: ImageResult, opts: SearchOptions): boolean {
  if (!matchesLicense(result.credit.license, opts.license)) return false
  if (result.width !== undefined && result.width < opts.minWidth) return false
  if (opts.orientation && result.width && result.height && orientationOf(result.width, result.height) !== opts.orientation) return false
  return true
}

/** Intercala os provedores (1º de um, 1º do outro…): nenhum domina a lista. */
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
 * Espera os provedores, mas sem deixar o mais lento segurar a resposta: quando um
 * já trouxe resultados, os outros têm `graceMs` para chegar. O que não chegou vira
 * aviso — a busca parcial ainda serve, e o agente pode repetir.
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
  // Os que ainda não responderam entram como aviso (a requisição segue e expira sozinha).
  return slots.map((slot, i) => slot ?? { results: [], warning: `${LABEL[providers[i]]}: too slow — repeat the search to include it` })
}

export async function searchImages(opts: SearchOptions, fetcher: Fetcher = fetch, graceMs = GRACE_MS): Promise<SearchOutcome> {
  const settled = await gather(opts.providers, opts, fetcher, graceMs)
  const warnings = settled.flatMap((s) => (s.warning ? [s.warning] : []))
  const lists = settled.map((s) => s.results.filter((r) => acceptable(r, opts)))
  const seen = new Set<string>()
  const results: ImageResult[] = []
  for (const result of interleave(lists)) {
    // O mesmo arquivo costuma vir dos dois (o Openverse indexa o Commons).
    const key = result.credit.sourceUrl
    if (seen.has(key)) continue
    seen.add(key)
    results.push(result)
    if (results.length >= opts.limit) break
  }
  return { results, warnings }
}
