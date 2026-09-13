import { createRequire } from 'node:module'
import {
  headingSize,
  normalizeStyle,
  renderOoxmlBody,
  type Block,
  type DocumentStyle,
  type ResolvedStyle,
} from './document-render'

/**
 * Empacota os blocos num .docx de verdade.
 *
 * Um .docx é um ZIP com algumas partes XML, e o JSZip já é dependência do
 * projeto — então o arquivo sai sem biblioteca nova. Fazer à mão também
 * delimita o escopo de forma honesta: suportamos o que o gerador produz
 * (títulos, parágrafos, listas, tabelas, negrito/itálico/código), e nada além.
 *
 * As quatro partes obrigatórias são [Content_Types].xml, _rels/.rels,
 * word/document.xml e o relacionamento dele. styles.xml e numbering.xml são
 * opcionais para o formato, mas sem eles o Word ignora os estilos de título e
 * desenha as listas sem marcador nenhum.
 */

const _require = createRequire(import.meta.url)

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`

/**
 * Estilos derivados do estilo do documento.
 *
 * O OOXML mede fonte em MEIOS-pontos (w:sz), então tudo é dobrado; a
 * justificação é do parágrafo (w:jc), não do corpo; e a cor do título é a
 * mesma cor de destaque usada no CSS, para o .docx e o PDF não divergirem.
 */
function stylesXml(style: ResolvedStyle): string {
  const half = (pt: number) => Math.round(pt * 2)
  const jc = style.align === 'justify' ? '<w:jc w:val="both"/>' : ''
  const heading = (level: 1 | 2 | 3, before: number, after: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${level - 1}"/><w:spacing w:before="${before}" w:after="${after}"/></w:pPr><w:rPr><w:b/><w:color w:val="${style.accentColor}"/><w:sz w:val="${half(headingSize(style, level))}"/></w:rPr></w:style>`

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${style.fontFamily}" w:hAnsi="${style.fontFamily}"/><w:sz w:val="${half(style.fontSize)}"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/>${jc}</w:pPr></w:style>
${heading(1, 240, 120)}
${heading(2, 240, 120)}
${heading(3, 200, 100)}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="444444"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:spacing w:after="60"/></w:pPr></w:style>
</w:styles>`
}

/** numId 1 = marcador, numId 2 = numerada (ver renderOoxmlBody). */
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function coreProps(title: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>Orbit</dc:creator>
<cp:lastModifiedBy>Orbit</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`
}

/** Twips por centímetro — a unidade de medida de página do OOXML. */
const TWIPS_PER_CM = 567

/**
 * Gera o .docx a partir dos blocos, em A4 retrato, com a margem e as colunas
 * do estilo. As colunas valem para a SEÇÃO inteira: o documento tem um
 * `sectPr` só, então é o documento todo em uma ou mais colunas — trecho a
 * trecho exigiria dividir em várias seções.
 */
export async function buildDocx(
  blocks: Block[],
  title: string,
  style?: DocumentStyle,
): Promise<Buffer> {
  const JSZip = _require('jszip') as typeof import('jszip')
  const resolved = normalizeStyle(style)
  const body = renderOoxmlBody(blocks, style)

  const marginTwips = Math.round(resolved.marginCm * TWIPS_PER_CM)
  const sideTwips = Math.round(Math.max(0.5, resolved.marginCm - 0.5) * TWIPS_PER_CM)
  const cols = resolved.columns > 1 ? `<w:cols w:num="${resolved.columns}" w:space="425"/>` : ''
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${marginTwips}" w:right="${sideTwips}" w:bottom="${marginTwips}" w:left="${sideTwips}"/>${cols}</w:sectPr></w:body></w:document>`

  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.folder('_rels')!.file('.rels', ROOT_RELS)
  zip.folder('docProps')!.file('core.xml', coreProps(title))
  const word = zip.folder('word')!
  word.file('document.xml', document)
  word.file('styles.xml', stylesXml(resolved))
  word.file('numbering.xml', NUMBERING)
  word.folder('_rels')!.file('document.xml.rels', DOC_RELS)

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
