import type { MediaCredit } from '@shared/media'
import type { ImageResult, LicenseFilter } from './types'

/**
 * Tradução das respostas das duas APIs para um formato só. Tudo aqui é puro: as
 * respostas reais ficam gravadas em fixtures, e é por elas que se nota quando um
 * provedor muda o formato.
 */

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** HTML de metadado (o autor no Commons vem com <a>, <bdi>…) → texto simples. */
export function plainText(html: string | undefined): string {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A linha de crédito pronta ("Título" de Autor, licenciada sob CC BY 2.0 — fonte). */
export function attributionLine(parts: { title?: string; creator?: string; license: string; licenseUrl?: string; sourceUrl: string }): string {
  const title = parts.title ? `"${parts.title}"` : 'Image'
  const by = parts.creator ? ` by ${parts.creator}` : ''
  const license = /public domain|cc0|pdm/i.test(parts.license) ? `marked ${parts.license}` : `licensed under ${parts.license}`
  const terms = parts.licenseUrl ? ` (${parts.licenseUrl})` : ''
  return `${title}${by}, ${license}${terms}. Source: ${parts.sourceUrl}`
}

/** A licença é de domínio público / CC0? */
export function isPublicDomain(license: string): boolean {
  return /public domain|cc0|pdm|no known copyright/i.test(license)
}

/** A licença NÃO permite uso comercial (NC) ou obra derivada (ND — cortar e enquadrar já é adaptar)? */
export function restrictsUse(license: string): boolean {
  return /\bNC\b|-nc|\bND\b|-nd/i.test(license)
}

/** Entra no filtro de licença pedido? */
export function matchesLicense(license: string, filter: LicenseFilter): boolean {
  if (filter === 'any') return true
  if (filter === 'public-domain') return isPublicDomain(license)
  return !restrictsUse(license)
}

// ---------------------------------------------------------------- Commons

interface CommonsPage {
  pageid?: number
  title?: string
  imageinfo?: Array<{
    width?: number
    height?: number
    mime?: string
    url?: string
    thumburl?: string
    descriptionurl?: string
    extmetadata?: Record<string, { value?: string } | undefined>
  }>
}

/** `File:Lion (Panthera leo) male 6y.jpg` → `Lion (Panthera leo) male 6y`. */
function commonsTitle(title: string): string {
  return title.replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ').trim()
}

export function parseCommons(json: unknown): ImageResult[] {
  const pages = (json as { query?: { pages?: Record<string, CommonsPage> } } | null)?.query?.pages
  if (!pages) return []
  const out: ImageResult[] = []
  // A API devolve um objeto, e a relevância está no `index` de cada página.
  const ordered = Object.values(pages).sort(
    (a, b) => ((a as { index?: number }).index ?? 0) - ((b as { index?: number }).index ?? 0),
  )
  for (const page of ordered) {
    const info = page.imageinfo?.[0]
    if (!info || !page.pageid || !page.title) continue
    if (!info.mime || !IMAGE_MIMES.has(info.mime)) continue
    const meta = info.extmetadata ?? {}
    const license = plainText(meta.LicenseShortName?.value) || plainText(meta.UsageTerms?.value)
    const downloadUrl = info.thumburl ?? info.url
    if (!license || !downloadUrl || !info.descriptionurl) continue
    const creator = plainText(meta.Artist?.value) || undefined
    const title = commonsTitle(page.title)
    const licenseUrl = meta.LicenseUrl?.value
    const credit: MediaCredit = {
      title,
      creator,
      license,
      licenseUrl,
      sourceUrl: info.descriptionurl,
      provider: 'commons',
      attribution: attributionLine({ title, creator, license, licenseUrl, sourceUrl: info.descriptionurl }),
    }
    out.push({
      id: `wc:${page.pageid}`,
      provider: 'commons',
      title,
      width: info.width,
      height: info.height,
      thumbUrl: info.thumburl ?? info.url ?? downloadUrl,
      downloadUrl,
      fallbackUrl: info.url && info.url !== downloadUrl ? info.url : undefined,
      credit,
    })
  }
  return out
}

// -------------------------------------------------------------- Openverse

interface OpenverseItem {
  id?: string
  title?: string
  creator?: string
  license?: string
  license_version?: string
  license_url?: string
  url?: string
  thumbnail?: string
  foreign_landing_url?: string
  width?: number
  height?: number
  filetype?: string | null
  source?: string
  provider?: string
}

/** `by-sa` + `4.0` → `CC BY-SA 4.0`; `cc0` + `1.0` → `CC0 1.0`; `pdm` → `Public Domain Mark 1.0`. */
export function openverseLicenseName(license: string | undefined, version: string | undefined): string {
  const l = (license ?? '').trim().toLowerCase()
  if (!l) return ''
  if (l === 'cc0') return `CC0 ${version ?? '1.0'}`
  if (l === 'pdm') return `Public Domain Mark ${version ?? '1.0'}`
  return `CC ${l.toUpperCase()}${version ? ` ${version}` : ''}`
}

export function parseOpenverse(json: unknown): ImageResult[] {
  const results = (json as { results?: OpenverseItem[] } | null)?.results
  if (!Array.isArray(results)) return []
  const out: ImageResult[] = []
  for (const item of results) {
    if (!item.id || !item.url || !item.foreign_landing_url) continue
    const license = openverseLicenseName(item.license, item.license_version)
    if (!license) continue
    const title = (item.title ?? '').trim() || undefined
    const creator = item.creator?.trim() || undefined
    const credit: MediaCredit = {
      title,
      creator,
      license,
      licenseUrl: item.license_url,
      sourceUrl: item.foreign_landing_url,
      provider: 'openverse',
      attribution: attributionLine({ title, creator, license, licenseUrl: item.license_url, sourceUrl: item.foreign_landing_url }),
    }
    out.push({
      id: `ov:${item.id}`,
      provider: 'openverse',
      title: title ?? 'Untitled',
      width: item.width,
      height: item.height,
      thumbUrl: item.thumbnail ?? item.url,
      downloadUrl: item.url,
      // A cópia que o próprio Openverse serve: quando o acervo de origem barra o
      // acesso direto (hotlink), esta continua respondendo.
      fallbackUrl: item.thumbnail,
      credit,
      origin: item.source ?? item.provider,
    })
  }
  return out
}
