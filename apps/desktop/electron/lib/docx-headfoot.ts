import { createRequire } from 'node:module'
import mammoth from 'mammoth'

/**
 * Header and footer of a .docx, in HTML.
 *
 * mammoth converts only the body: `word/header*.xml` and `word/footer*.xml` do not
 * enter the HTML, so the panel showed the document without the two even when
 * the file (and its PDF) had them — it was the case of a report whose
 * header was a letterhead image.
 *
 * Instead of reinterpreting the XML, each part becomes a minimal .docx whose BODY is its
 * content, and mammoth converts that file as it converts any
 * other. The part's relationships (the letterhead images) become the relationships of the
 * synthetic document, and the `media/...` paths keep holding because
 * both stay in `word/`.
 */

const _require = createRequire(import.meta.url)

export interface HeadFoot {
  header: string
  footer: string
}

const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** Value of an attribute in a tag, whatever the order of the attributes. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag)
  return m ? m[1] : null
}

/** Path of the `default` part (header or footer) of the first section that has it. */
function partTarget(documentXml: string, rels: string, kind: 'header' | 'footer'): string | null {
  const refs = documentXml.match(new RegExp(`<w:${kind}Reference\\b[^>]*>`, 'g')) ?? []
  const ref = refs.find((tag) => attr(tag, 'w:type') === 'default')
  const id = ref ? attr(ref, 'r:id') : null
  if (!id) return null
  for (const rel of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    if (attr(rel, 'Id') === id) return attr(rel, 'Target')
  }
  return null
}

function resolvePart(target: string): string {
  return target.startsWith('/') ? target.slice(1) : `word/${target}`
}

async function partToHtml(
  JSZip: typeof import('jszip'),
  buffer: Buffer,
  partPath: string,
  root: 'hdr' | 'ftr',
): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file(partPath)?.async('string')
  if (!xml) return ''
  const open = new RegExp(`<w:${root}\\b([^>]*)>`).exec(xml)
  const close = xml.lastIndexOf(`</w:${root}>`)
  if (!open || close < 0) return ''
  const inner = xml.slice(open.index + open[0].length, close)
  // Empty part (only a blank paragraph) does not get a box in the panel.
  if (!/<w:t[\s>]/.test(inner) && !/<a:blip\b|<v:imagedata\b/.test(inner)) return ''

  const relsPath = partPath.replace(/([^/]+)$/, '_rels/$1.rels')
  const rels =
    (await zip.file(relsPath)?.async('string')) ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS_REL}"/>`

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document${open[1]}><w:body>${inner}</w:body></w:document>`,
  )
  zip.file('word/_rels/document.xml.rels', rels)
  const synthetic = await zip.generateAsync({ type: 'nodebuffer' })
  const { value } = await mammoth.convertToHtml({ buffer: synthetic })
  return value
}

/** Default header and footer of the document; '' when there are none (or they are empty). */
export async function docxHeadFoot(buffer: Buffer): Promise<HeadFoot> {
  const none: HeadFoot = { header: '', footer: '' }
  try {
    const JSZip = _require('jszip') as typeof import('jszip')
    const zip = await JSZip.loadAsync(buffer)
    const documentXml = await zip.file('word/document.xml')?.async('string')
    const rels = await zip.file('word/_rels/document.xml.rels')?.async('string')
    if (!documentXml || !rels) return none

    const head = partTarget(documentXml, rels, 'header')
    const foot = partTarget(documentXml, rels, 'footer')
    return {
      header: head ? await partToHtml(JSZip, buffer, resolvePart(head), 'hdr') : '',
      footer: foot ? await partToHtml(JSZip, buffer, resolvePart(foot), 'ftr') : '',
    }
  } catch {
    // A header that does not convert cannot bring the document down: the body counts.
    return none
  }
}

/** The body with the header before and the footer after, when they exist. */
export function withHeadFoot(body: string, { header, footer }: HeadFoot): string {
  return (
    (header ? `<header data-docx-part="header">${header}</header>` : '') +
    body +
    (footer ? `<footer data-docx-part="footer">${footer}</footer>` : '')
  )
}
