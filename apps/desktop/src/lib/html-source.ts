/**
 * Is this "Markdown" actually an HTML page?
 *
 * A page saved from the browser and an exported app are both a pile of markup, and
 * they get to the conversation with whatever extension the file had — `.md` among
 * them. Rendering one as Markdown is a trap: the raw HTML is parsed as HTML, the
 * sanitizer keeps almost nothing, and what survives is the text of the `<title>`
 * ("Orbit") on top of an empty page. The file looks broken when it only needed to be
 * read.
 *
 * The test looks at the START of the text: those files open with the doctype or the
 * root element. A README that merely mentions `<body>` halfway through stays
 * Markdown.
 */

/** A document-level element — the signature of a whole page, not of a snippet. */
const HTML_DOCUMENT = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i

/** How far in to look. The doctype and the root are in the first lines; beyond this
 *  the mention is prose. */
const HEAD_CHARS = 2048

export function isHtmlDocument(text: string): boolean {
  return HTML_DOCUMENT.test(text.slice(0, HEAD_CHARS))
}
