import type { CompanionSource } from '@orbit/shared'

/**
 * Pure helpers of the Sources screen (mirror of apps/desktop/src/components/sources-tab.tsx).
 * `draft` is the scope of a chat that is not a session yet — same constant as the desktop.
 */
export const DRAFT_SCOPE = 'draft'

/** Ceiling per file, same as the desktop tab (it is a barrier, not a usage limit). */
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Upper-cased extension when the name has a real one ("PDF", "MD"); null for sites and
 *  names like "Sales 2026.1" (an extension starts with a letter). */
export function sourceTypeLabel(source: Pick<CompanionSource, 'kind' | 'filename'>): string | null {
  if (source.kind === 'web') return null
  const ext = /\.([a-z][a-z0-9]{0,4})$/i.exec(source.filename.trim())?.[1]
  return ext ? ext.toUpperCase() : null
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Accepts "example.com/page" as well as a full address; only http(s) is a valid source. */
export function normalizeSourceUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw || /\s/.test(raw)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null
    return url.toString()
  } catch {
    return null
  }
}

/** Unit word key for the page count, by kind. */
export function sourceUnitKey(kind: CompanionSource['kind']): 'unitSheets' | 'unitBlocks' | 'unitPages' {
  return kind === 'spreadsheet' ? 'unitSheets' : kind === 'docx' ? 'unitBlocks' : 'unitPages'
}

/** Newest first inside an area — the order a person adding things expects. */
export function sortSources(list: CompanionSource[]): CompanionSource[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
}
