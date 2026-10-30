import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { buildDocx } from './docx-package'
import {
  mermaidSourcesOf,
  parseMarkdown,
  renderHtml,
  renderOoxmlBody,
  type DiagramLookup,
  type RenderedDiagram,
} from './document-render'

/**
 * A ```mermaid block has two destinations: drawn (SVG in the HTML/PDF, PNG in
 * the .docx) when the main managed to render it, and a code block when it did
 * not. The drawing itself needs a DOM and stays out of here; what is tested
 * is the fit — that the diagram enters where it should and that the .docx stays a
 * valid package with the image inside.
 */

const SOURCE = 'flowchart LR\n  A --> B'
const MD = `# Fluxo\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\nDepois.`

const fake: RenderedDiagram = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect/></svg>',
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  width: 400,
  height: 200,
}
const drawn: DiagramLookup = (source) => (source === SOURCE ? fake : undefined)
const failed: DiagramLookup = () => undefined

describe('mermaidSourcesOf', () => {
  it('takes only the mermaid blocks, with the source trimmed', () => {
    const blocks = parseMarkdown(`${MD}\n\n\`\`\`ts\nconst x = 1\n\`\`\``)
    expect(mermaidSourcesOf(blocks)).toEqual([SOURCE])
  })

  it('an empty mermaid block does not go to the renderer', () => {
    expect(mermaidSourcesOf(parseMarkdown('```mermaid\n```'))).toEqual([])
  })
})

describe('HTML (preview and PDF)', () => {
  it('embeds the SVG in place of the block', () => {
    const html = renderHtml(parseMarkdown(MD), 'Fluxo', undefined, drawn)
    expect(html).toContain('<figure class="diagram">')
    expect(html).toContain(fake.svg)
    expect(html).not.toContain('flowchart LR')
  })

  it('a diagram that did not render becomes code again, without disappearing', () => {
    const html = renderHtml(parseMarkdown(MD), 'Fluxo', undefined, failed)
    expect(html).not.toContain('class="diagram"')
    expect(html).toContain('flowchart LR')
  })

  it('a pending page break goes to the diagram', () => {
    const blocks = parseMarkdown(`Before\n\n\\pagebreak\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\``)
    expect(renderHtml(blocks, 'x', undefined, drawn)).toContain('class="diagram page-break"')
  })
})

describe('OOXML', () => {
  it('a registered diagram becomes an inline centered image', () => {
    const xml = renderOoxmlBody(parseMarkdown(MD), undefined, (s) =>
      s === SOURCE ? { rId: 'rId3', width: 400, height: 200 } : undefined,
    )
    expect(xml).toContain('<a:blip r:embed="rId3"/>')
    expect(xml).toContain(`<wp:extent cx="${400 * 9525}" cy="${200 * 9525}"/>`)
    expect(xml).toContain('<w:jc w:val="center"/>')
    expect(xml).not.toContain('flowchart LR')
  })

  it('a wide diagram shrinks to the column, keeping the proportion', () => {
    const xml = renderOoxmlBody(parseMarkdown(MD), { columns: 2 }, () => ({
      rId: 'rId3',
      width: 2000,
      height: 1000,
    }))
    const [, cx, cy] = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/)!.map(Number)
    expect(cx).toBeLessThan(2000 * 9525)
    expect(cx / cy).toBeCloseTo(2, 2)
  })

  it('without an image, the block comes out as code', () => {
    expect(renderOoxmlBody(parseMarkdown(MD))).toContain('flowchart LR')
  })
})

describe('buildDocx', () => {
  it('puts the PNG in the package, with relationship and content type', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(parseMarkdown(MD), 'Fluxo', undefined, drawn))
    const png = await zip.file('word/media/diagram1.png')!.async('nodebuffer')
    expect(png.equals(fake.png)).toBe(true)

    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(rels).toContain('Id="rId3"')
    expect(rels).toContain('Target="media/diagram1.png"')

    const types = await zip.file('[Content_Types].xml')!.async('string')
    expect(types).toContain('Extension="png"')

    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('xmlns:wp=')
    expect(doc).toContain('xmlns:r=')
    expect(doc).toContain('r:embed="rId3"')
  })

  it('the same source repeated goes in only once in the package', async () => {
    const zip = await JSZip.loadAsync(
      await buildDocx(parseMarkdown(`${MD}\n\n${MD}`), 'x', undefined, drawn),
    )
    expect(Object.keys(zip.files).filter((f) => f.endsWith('.png'))).toEqual([
      'word/media/diagram1.png',
    ])
    const doc = await zip.file('word/document.xml')!.async('string')
    // Each occurrence is its own drawing (unique docPr id), the image is the same.
    expect(doc.match(/r:embed="rId3"/g)).toHaveLength(2)
    expect(doc).toContain('<wp:docPr id="2"')
  })
})
