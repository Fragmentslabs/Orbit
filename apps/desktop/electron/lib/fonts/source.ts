import fsp from 'node:fs/promises'
import path from 'node:path'
import { addFont, findFont, fontsRoot, storeFontFile, type FontFileRef, type OrbitFont } from './store'

/**
 * Where the fonts come from: the Fontsource catalog (jsDelivr).
 *
 * Fontsource only, and not a generic web search: the package says which license it
 * is (`OFL-1.1`), which subsets exist, the axes of the variable font and the
 * `unicode-range` of each subset — the `@font-face` we generate depends on that. And
 * the file name is predictable (`<id>-<subset>-<weight>-<style>.woff2`), without
 * scraping CSS or forging a User-Agent to receive woff2.
 *
 * The version stays fixed on what was DOWNLOADED (the index keeps the file, not the
 * URL): tomorrow's render uses the same bytes, not whatever is up in the air.
 */

const CATALOG_URL = 'https://api.fontsource.org/v1/fonts'
const NPM_CDN = 'https://cdn.jsdelivr.net/npm'
const ALLOWED_HOSTS = new Set(['api.fontsource.org', 'cdn.jsdelivr.net'])
const USER_AGENT = 'Orbit/1.0 (+https://github.com/orbit) fonts'
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_FONT_BYTES = 4 * 1024 * 1024
const MAX_JSON_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 20_000

/** Subsets worth downloading by default: it covers Portuguese (accents included) and Latin. */
const DEFAULT_SUBSETS = ['latin', 'latin-ext']

export interface CatalogFont {
  id: string
  family: string
  subsets: string[]
  weights: number[]
  styles: string[]
  defSubset?: string
  variable: boolean
  category?: string
  license?: string
  type?: string
}

interface FontsourceMetadata {
  id?: string
  family?: string
  subsets?: string[]
  weights?: number[]
  styles?: string[]
  defSubset?: string
  category?: string
  license?: { type?: string; url?: string; attribution?: string } | string
  variable?: Record<string, { min?: string; max?: string; default?: string }> | boolean
}

type Fetcher = typeof fetch

export interface SourceOptions {
  fetcher?: Fetcher
  now?: () => number
}

function catalogFile(): string {
  return path.join(fontsRoot(), 'catalog.json')
}

/** https only, and only on Fontsource hosts — the URL is never chosen by the model. */
function checked(url: string): URL {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('the font address must be https')
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error(`unexpected font host: ${parsed.hostname}`)
  return parsed
}

/** Reads the body with a byte ceiling — content-length may be missing or lie. */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > limit) throw new Error(`the file is ${(declared / 1e6).toFixed(1)} MB, above the ${(limit / 1024 / 1024).toFixed(0)} MB limit`)
  const reader = res.body?.getReader()
  if (!reader) throw new Error('empty response')
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel()
      throw new Error(`the file is above the ${(limit / 1024 / 1024).toFixed(0)} MB limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function getJson(url: string, options: SourceOptions, limit = MAX_JSON_BYTES): Promise<unknown> {
  checked(url)
  const fetcher = options.fetcher ?? fetch
  const res = await fetcher(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`the font server answered ${res.status}`)
  return JSON.parse((await readCapped(res, limit)).toString('utf8'))
}

/**
 * The whole catalog (≈2 thousand families), on disk for a week. The search is local:
 * filtering 2 thousand names is instant and does not depend on there being a network
 * on every query.
 */
export async function catalog(options: SourceOptions = {}): Promise<CatalogFont[]> {
  const now = options.now?.() ?? Date.now()
  let cached: { at: number; fonts: CatalogFont[] } | null = null
  try {
    cached = JSON.parse(await fsp.readFile(catalogFile(), 'utf8')) as { at: number; fonts: CatalogFont[] }
  } catch {
    cached = null
  }
  if (cached && Array.isArray(cached.fonts) && now - cached.at < CATALOG_TTL_MS) return cached.fonts

  try {
    const raw = (await getJson(CATALOG_URL, options)) as CatalogFont[]
    const fonts = raw.filter((font) => typeof font?.id === 'string' && typeof font?.family === 'string')
    await fsp.mkdir(fontsRoot(), { recursive: true })
    await fsp.writeFile(catalogFile(), JSON.stringify({ at: now, fonts }), 'utf8')
    return fonts
  } catch (err) {
    // No network right now: the old catalog still serves to search and use what has
    // already been downloaded (the local library does not depend on it).
    if (cached?.fonts?.length) return cached.fonts
    throw new Error(`could not read the font catalog: ${(err as Error).message}`)
  }
}

/** Search by name, with the family that STARTS with the term in front. */
export function searchCatalog(fonts: CatalogFont[], query: string, limit = 8): CatalogFont[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return fonts.slice(0, limit)
  const scored = fonts
    .map((font) => {
      const family = font.family.toLowerCase()
      const id = font.id.toLowerCase()
      let score = 0
      for (const word of words) {
        if (family === word || id === word) score += 100
        else if (family.startsWith(word)) score += 60
        else if (id.startsWith(word)) score += 40
        else if (family.includes(word)) score += 20
        else if (id.includes(word)) score += 10
        else return null
      }
      return { font, score }
    })
    .filter((item): item is { font: CatalogFont; score: number } => item !== null)
    .sort((a, b) => b.score - a.score || a.font.family.length - b.font.family.length)
  return scored.slice(0, limit).map((item) => item.font)
}

async function resolveCatalogFont(ref: string, options: SourceOptions): Promise<CatalogFont> {
  const fonts = await catalog(options)
  const wanted = ref.trim().toLowerCase()
  const exact =
    fonts.find((font) => font.id.toLowerCase() === wanted) ??
    fonts.find((font) => font.family.toLowerCase() === wanted) ??
    searchCatalog(fonts, ref, 1)[0]
  if (!exact) throw new Error(`no font named "${ref}" in the catalog - search with font_search first`)
  return exact
}

function licenseOf(metadata: FontsourceMetadata): OrbitFont['license'] | undefined {
  const raw = metadata.license
  if (!raw) return undefined
  if (typeof raw === 'string') return { type: raw }
  const type = raw.type ?? ''
  if (!type) return undefined
  return { type, url: raw.url, attribution: raw.attribution }
}

/** Accepts the file only if it STARTS like a font — an HTML 404 does not enter the store. */
function fontExt(buffer: Buffer): 'woff2' | 'woff' | 'ttf' | 'otf' {
  const magic = buffer.subarray(0, 4).toString('latin1')
  if (magic === 'wOF2') return 'woff2'
  if (magic === 'wOFF') return 'woff'
  if (magic === 'OTTO') return 'otf'
  if (magic === 'true' || magic.charCodeAt(0) === 0) return 'ttf'
  throw new Error('the downloaded file is not a font')
}

interface PackageInfo {
  package: string
  variable: boolean
  metadata: FontsourceMetadata
}

async function packageInfo(font: CatalogFont, options: SourceOptions): Promise<PackageInfo> {
  const candidates = [`${NPM_CDN}/@fontsource-variable/${font.id}@latest/metadata.json`, `${NPM_CDN}/@fontsource/${font.id}@latest/metadata.json`]
  let lastError: Error | null = null
  for (const url of candidates) {
    try {
      const metadata = (await getJson(url, options, 4 * 1024 * 1024)) as FontsourceMetadata
      return { package: url.split('/npm/')[1].split('@latest')[0], variable: url.includes('@fontsource-variable/'), metadata }
    } catch (err) {
      lastError = err as Error
    }
  }
  throw new Error(`could not read the font package of "${font.family}": ${lastError?.message ?? 'unknown error'}`)
}

/** The `unicode-range` per subset, when the package reports it. */
async function unicodeRanges(packageName: string, options: SourceOptions): Promise<Record<string, string>> {
  try {
    return (await getJson(`${NPM_CDN}/${packageName}@latest/unicode.json`, options)) as Record<string, string>
  } catch {
    return {}
  }
}

async function downloadFile(url: string, options: SourceOptions): Promise<Buffer> {
  checked(url)
  const fetcher = options.fetcher ?? fetch
  const res = await fetcher(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'font/woff2,font/woff,font/*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`the font server answered ${res.status}`)
  return readCapped(res, MAX_FONT_BYTES)
}

export interface EnsureOptions {
  /** Desired subsets; the default covers Latin + Portuguese. */
  subsets?: string[]
  styles?: ('normal' | 'italic')[]
}

/**
 * Guarantees the family in the library (downloading if needed) and returns the index
 * entry. Idempotent: with the family already installed, it does not touch the network.
 */
export async function ensureFont(ref: string, ensure: EnsureOptions = {}, options: SourceOptions = {}): Promise<OrbitFont> {
  const existing = await findFont(ref)
  if (existing) return existing

  const font = await resolveCatalogFont(ref, options)
  const info = await packageInfo(font, options)
  const metadata = info.metadata
  const available = metadata.subsets?.length ? metadata.subsets : font.subsets
  const wanted = (ensure.subsets?.length ? ensure.subsets : DEFAULT_SUBSETS).filter((subset) => available.includes(subset))
  const subsets = wanted.length > 0 ? wanted : [metadata.defSubset ?? font.defSubset ?? available[0]].filter(Boolean)
  const styles = ((ensure.styles?.length ? ensure.styles : ['normal']) as ('normal' | 'italic')[]).filter((style) =>
    (metadata.styles?.length ? metadata.styles : font.styles).includes(style),
  )
  if (subsets.length === 0 || styles.length === 0) throw new Error(`"${font.family}" has no usable subset or style`)

  const ranges = await unicodeRanges(info.package, options)
  const axis = metadata.variable && typeof metadata.variable === 'object' ? metadata.variable.wght : undefined
  const variableWeight = axis?.min && axis?.max ? `${axis.min} ${axis.max}` : '100 900'
  const staticWeight = String(font.weights.includes(400) ? 400 : font.weights[0] ?? 400)

  const files: FontFileRef[] = []
  let lastError: Error | null = null
  for (const subset of subsets) {
    for (const style of styles) {
      const file = info.variable
        ? `${font.id}-${subset}-wght-${style}.woff2`
        : `${font.id}-${subset}-${staticWeight}-${style}.woff2`
      try {
        const buffer = await downloadFile(`${NPM_CDN}/${info.package}@latest/files/${file}`, options)
        const ext = fontExt(buffer)
        const name = await storeFontFile(buffer, ext)
        files.push({
          file: name,
          subset,
          weight: info.variable ? variableWeight : staticWeight,
          style,
          unicodeRange: ranges[subset],
        })
      } catch (err) {
        // A subset the package does not publish (common in a variable font): go on with the others.
        lastError = err as Error
      }
    }
  }
  if (files.length === 0) throw new Error(`could not download "${font.family}": ${lastError?.message ?? 'no file available'}`)

  const entry: OrbitFont = {
    id: font.id,
    family: metadata.family ?? font.family,
    category: metadata.category ?? font.category,
    license: licenseOf(metadata) ?? (font.license ? { type: font.license } : undefined),
    variable: info.variable,
    weights: info.variable ? [variableWeight] : [staticWeight],
    styles,
    subsets: [...new Set(files.map((ref) => ref.subset))],
    files,
    addedAt: Date.now(),
  }
  return addFont(entry)
}
