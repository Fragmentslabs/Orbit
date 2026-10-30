import { createRequire } from 'node:module'
import {
  headingSize,
  normalizeStyle,
  renderOoxmlBody,
  mermaidSourcesOf,
  type Block,
  type DiagramLookup,
  type DocxImage,
  type DocumentStyle,
  type ResolvedStyle,
} from './document-render'

/**
 * Packages the blocks into a real .docx.
 *
 * A .docx is a ZIP with some XML parts, and JSZip is already a dependency of the
 * project — so the file comes out without a new library. Doing it by hand also
 * delimits the scope honestly: we support what the generator produces
 * (headings, paragraphs, lists, tables, bold/italic/code), and nothing beyond.
 *
 * The four mandatory parts are [Content_Types].xml, _rels/.rels,
 * word/document.xml and its relationship. styles.xml and numbering.xml are
 * optional for the format, but without them Word ignores the heading styles and
 * draws the lists with no bullet at all.
 */

const _require = createRequire(import.meta.url)

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
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

/** rId1 and rId2 are fixed; the diagrams' images come later, from rId3 on. */
function docRels(media: string[]): string {
  const images = media
    .map(
      (file, i) =>
        `<Relationship Id="rId${i + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${file}"/>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${images}
</Relationships>`
}

/**
 * Styles derived from the document's style.
 *
 * OOXML measures font in HALF-points (w:sz), so everything is doubled; the
 * justification is the paragraph's (w:jc), not the body's; and the heading's color is the
 * same accent color used in the CSS, so that the .docx and the PDF do not diverge.
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
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="HTML Preformatted"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/><w:ind w:left="170"/><w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="${half(Math.max(7, style.fontSize - 1.5))}"/></w:rPr></w:style>
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

/** Twips per centimeter — OOXML's page measurement unit. */
const TWIPS_PER_CM = 567

/**
 * Generates the .docx from the blocks, in portrait A4, with the margin and the columns
 * from the style. The columns count for the WHOLE SECTION: the document has a single
 * `sectPr`, so it is the whole document in one or more columns — stretch by
 * stretch would require splitting into several sections.
 */
export async function buildDocx(
  blocks: Block[],
  title: string,
  style?: DocumentStyle,
  diagrams?: DiagramLookup,
): Promise<Buffer> {
  const JSZip = _require('jszip') as typeof import('jszip')
  const resolved = normalizeStyle(style)

  // Each drawn diagram becomes a PNG in the package, only once even if the
  // same source repeats. What did not draw stays without an image and the body
  // writes it as a code block.
  const images = new Map<string, DocxImage & { png: Buffer; file: string }>()
  for (const source of mermaidSourcesOf(blocks)) {
    const diagram = diagrams?.(source)
    if (!diagram || images.has(source)) continue
    const n = images.size + 1
    images.set(source, {
      rId: `rId${n + 2}`,
      width: diagram.width,
      height: diagram.height,
      png: diagram.png,
      file: `diagram${n}.png`,
    })
  }
  const body = renderOoxmlBody(blocks, style, (source) => images.get(source))

  const marginTwips = Math.round(resolved.marginCm * TWIPS_PER_CM)
  const sideTwips = Math.round(Math.max(0.5, resolved.marginCm - 0.5) * TWIPS_PER_CM)
  const cols = resolved.columns > 1 ? `<w:cols w:num="${resolved.columns}" w:space="425"/>` : ''
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${marginTwips}" w:right="${sideTwips}" w:bottom="${marginTwips}" w:left="${sideTwips}"/>${cols}</w:sectPr></w:body></w:document>`

  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.folder('_rels')!.file('.rels', ROOT_RELS)
  zip.folder('docProps')!.file('core.xml', coreProps(title))
  const word = zip.folder('word')!
  word.file('document.xml', document)
  word.file('styles.xml', stylesXml(resolved))
  word.file('numbering.xml', NUMBERING)
  word.folder('_rels')!.file('document.xml.rels', docRels([...images.values()].map((i) => i.file)))
  for (const image of images.values()) word.folder('media')!.file(image.file, image.png)

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
