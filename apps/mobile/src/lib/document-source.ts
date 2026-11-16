import type { DocumentTextView } from '@orbit/companion-client'

/**
 * Document citations and the HTML the phone draws for a source's text.
 *
 * The citation contract is the desktop's (`apps/desktop/src/lib/citations.ts`):
 * `#orbit-source/<docId>/p<page>[L<from>[-<to>]]`. Breaking it is silent — an address that does
 * not match is just a link that opens nothing — so it is pure and tested here.
 */

export const SOURCE_HREF = /^#orbit-source\/([a-z]+\d+)\/p(\d+)(?:L(\d+)(?:-(\d+))?)?$/i

export interface SourceRef {
  docId: string
  page: number
  fromLine?: number
  toLine?: number
}

export function parseSourceHref(href: string): SourceRef | null {
  const match = SOURCE_HREF.exec(href.trim())
  if (!match) return null
  return {
    docId: match[1],
    page: Number(match[2]),
    fromLine: match[3] ? Number(match[3]) : undefined,
    toLine: match[4] ? Number(match[4]) : undefined,
  }
}

/** Answers saved before the fragment format wrote `orbit-source://…`; the sanitizer used to eat it. */
export function rescueLegacyCitations(markdown: string): string {
  return markdown.includes('](orbit-source://')
    ? markdown.replaceAll('](orbit-source://', '](#orbit-source/')
    : markdown
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Lines drawn in one document — the same ceiling as the desktop's Text mode. */
export const MAX_LINES = 20_000

export interface SourceHtmlOptions {
  cite?: { page: number; fromLine?: number; toLine?: number }
  /** Heading of a page: a spreadsheet's sheet, a docx block or a PDF page. */
  pageTitle: (page: DocumentTextView['pages'][number], kind: DocumentTextView['kind']) => string
  colors: {
    background: string
    foreground: string
    muted: string
    border: string
    accent: string
    /** Translucent accent behind the cited lines. */
    highlight: string
  }
}

/** Last cited line, never before the first. */
export function citedRange(cite: SourceHtmlOptions['cite']): { from: number; to: number } | null {
  if (!cite?.fromLine) return null
  return { from: cite.fromLine, to: Math.max(cite.fromLine, cite.toLine ?? cite.fromLine) }
}

/**
 * The source as a scrollable page: a heading per page (the outline/jump targets), the numbered
 * lines the model saw, and the cited lines marked (`.cited`, scrolled into view by the viewer).
 */
export function buildSourceHtml(view: DocumentTextView, options: SourceHtmlOptions): string {
  const { colors } = options
  const range = citedRange(options.cite)
  const body: string[] = []
  let drawn = 0
  let truncated = false
  for (const page of view.pages) {
    if (drawn >= MAX_LINES) {
      truncated = true
      break
    }
    body.push(`<h2 id="p${page.num}">${escapeHtml(options.pageTitle(page, view.kind))}</h2>`)
    page.lines.forEach((line, index) => {
      if (drawn >= MAX_LINES) {
        truncated = true
        return
      }
      drawn += 1
      const n = index + 1
      const cited =
        range && options.cite?.page === page.num && n >= range.from && n <= range.to
      body.push(
        `<div class="l${cited ? ' cited' : ''}"><span class="n">${n}</span><span class="t">${escapeHtml(line) || '&nbsp;'}</span></div>`,
      )
    })
  }
  if (truncated) body.push('<p class="cut">…</p>')
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, user-scalable=yes">
<style>
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:12px 14px 40px;background:${colors.background};color:${colors.foreground};font:15px/1.5 -apple-system,system-ui,sans-serif}
h2{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${colors.accent};margin:22px 0 6px;padding-bottom:4px;border-bottom:1px solid ${colors.border}}
h2:first-child{margin-top:0}
.l{display:flex;gap:10px;padding:1px 0}
.n{flex:none;width:2.4em;text-align:right;color:${colors.muted};font:11px/1.9 ui-monospace,Menlo,monospace;user-select:none}
.t{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.cited{background:${colors.highlight};border-radius:3px;box-shadow:-3px 0 0 ${colors.accent}}
.cut{color:${colors.muted}}
</style></head><body>${body.join('')}</body></html>`
}

/** HTML of a converted .docx wrapped in the app's palette (the desktop sends the bare body). */
export function wrapDocxHtml(html: string, colors: SourceHtmlOptions['colors']): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, user-scalable=yes">
<style>
body{margin:0;padding:14px 16px 40px;background:${colors.background};color:${colors.foreground};font:16px/1.55 -apple-system,system-ui,sans-serif;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto}
td,th{border:1px solid ${colors.border};padding:4px 8px}
a{color:${colors.accent}}
</style></head><body>${html}</body></html>`
}

/** Plain text of the whole source, for sharing. */
export function sourceToText(view: DocumentTextView): string {
  return view.pages.map((p) => p.lines.join('\n')).join('\n\n')
}
