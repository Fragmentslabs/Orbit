import { createRequire } from 'node:module'
import mammoth from 'mammoth'

/**
 * Cabeçalho e rodapé de um .docx, em HTML.
 *
 * O mammoth converte só o corpo: `word/header*.xml` e `word/footer*.xml` não
 * entram no HTML, então o painel mostrava o documento sem os dois mesmo quando
 * o arquivo (e o PDF dele) os tinha — foi o caso de um relatório cujo
 * cabeçalho era um timbre em imagem.
 *
 * Em vez de reinterpretar o XML, cada parte vira um .docx mínimo cujo CORPO é o
 * conteúdo dela, e o mammoth converte esse arquivo como converte qualquer
 * outro. As relações da parte (as imagens do timbre) viram as relações do
 * documento sintético, e os caminhos `media/...` continuam valendo porque
 * ambas ficam em `word/`.
 */

const _require = createRequire(import.meta.url)

export interface HeadFoot {
  header: string
  footer: string
}

const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** Valor de um atributo numa tag, qualquer que seja a ordem dos atributos. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag)
  return m ? m[1] : null
}

/** Caminho da parte `default` (header ou footer) da primeira seção que a tem. */
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
  // Parte vazia (só parágrafo em branco) não ganha caixa no painel.
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

/** Cabeçalho e rodapé padrão do documento; '' quando não há (ou estão vazios). */
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
    // Cabeçalho que não converte não pode derrubar o documento: o corpo vale.
    return none
  }
}

/** O corpo com o cabeçalho antes e o rodapé depois, quando existem. */
export function withHeadFoot(body: string, { header, footer }: HeadFoot): string {
  return (
    (header ? `<header data-docx-part="header">${header}</header>` : '') +
    body +
    (footer ? `<footer data-docx-part="footer">${footer}</footer>` : '')
  )
}
