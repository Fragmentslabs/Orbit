import { Marked } from 'marked'
import type { DocumentTextView } from '@orbit/companion-client'
import { escapeHtml, type SourceHtmlOptions } from './document-source'

/**
 * A Markdown source drawn as a document, the way the desktop's "Document" mode does.
 *
 * The desktop opens a `.md` as a rendered document and keeps "Text" (numbered lines) for citations.
 * Same rules here: only Markdown files (`.txt` stays plain text), and never an HTML page saved with
 * an `.md` extension — rendering one as Markdown leaves an empty page.
 */

const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i
/** A document-level element: the signature of a whole page, not of a snippet. */
const HTML_DOCUMENT = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i
/** How far in to look: the doctype and the root open the file; later mentions are prose. */
const HEAD_CHARS = 2048

export function isHtmlDocument(text: string): boolean {
  return HTML_DOCUMENT.test(text.slice(0, HEAD_CHARS))
}

/** The source as one Markdown text: the synthetic reading pages joined by a blank line. */
export function markdownOf(view: Pick<DocumentTextView, 'pages'>): string {
  return view.pages.map((p) => p.lines.join('\n')).join('\n\n')
}

/** Is this source a Markdown file that reads better rendered? */
export function isMarkdownSource(view: Pick<DocumentTextView, 'kind' | 'filename' | 'pages'>): boolean {
  return view.kind === 'text' && MARKDOWN_FILE.test(view.filename) && !isHtmlDocument(markdownOf(view))
}

const SAFE_IMAGE = /^https:\/\//i

// Raw HTML in the file is shown as text, never run; links are drawn but not followed (a tap would
// navigate the viewer's WebView away from the document); images only over https.
const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link({ tokens }) {
      return `<span class="a">${this.parser.parseInline(tokens)}</span>`
    },
    image: ({ href, text }) =>
      SAFE_IMAGE.test(href) ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">` : escapeHtml(text),
  },
})

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown) as string
}

/** The rendered Markdown wrapped in the app's palette. */
export function buildMarkdownHtml(markdown: string, colors: SourceHtmlOptions['colors']): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, user-scalable=yes">
<style>
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:14px 16px 48px;background:${colors.background};color:${colors.foreground};font:16px/1.6 -apple-system,system-ui,sans-serif;overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .5em;font-weight:650}
h1{font-size:1.6em;padding-bottom:.25em;border-bottom:1px solid ${colors.border}}
h2{font-size:1.35em;padding-bottom:.2em;border-bottom:1px solid ${colors.border}}
h3{font-size:1.15em}h4,h5,h6{font-size:1em}
body>:first-child{margin-top:0}
p,ul,ol,blockquote,pre,table{margin:0 0 1em}
ul,ol{padding-left:1.5em}
li>p{margin:0}
.a{color:${colors.accent};text-decoration:underline;text-underline-offset:2px}
blockquote{margin-left:0;padding:.1em 1em;border-left:3px solid ${colors.border};color:${colors.muted}}
code{font:.88em ui-monospace,Menlo,monospace;background:${colors.border};padding:.1em .35em;border-radius:4px}
pre{background:${colors.border};padding:12px;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0;font-size:.85em}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}
td,th{border:1px solid ${colors.border};padding:5px 10px}
th{font-weight:600;text-align:left}
hr{border:0;border-top:1px solid ${colors.border};margin:1.5em 0}
img{max-width:100%;height:auto}
del{color:${colors.muted}}
</style></head><body>${markdownToHtml(markdown)}</body></html>`
}
