/**
 * Sanitizing of the HTML that mammoth generates from a .docx from outside.
 *
 * Separated from the rest so it is testable without Electron: it is the part of the path
 * that answers for security, and it is the one that most needs testing.
 */

/** Schemes a document link may have. The rest becomes a dead anchor. */
const LINK_SEGURO = /^(https?:|mailto:|#)/i

export function sanitizeDocxHtml(html: string): string {
  return (
    html
      // mammoth does not write <script>, but the guarantee cannot depend on that.
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/<a\s+([^>]*?)href\s*=\s*"([^"]*)"([^>]*)>/gi, (_all, before, href, after) => {
        const target = LINK_SEGURO.test(href.trim()) ? href : '#'
        // target=_blank takes the click to the main's setWindowOpenHandler, which only
        // opens http(s) in the system browser and denies the rest — the document
        // never navigates the panel itself.
        return `<a ${before}href="${target}"${after} target="_blank" rel="noreferrer">`
      })
  )
}
