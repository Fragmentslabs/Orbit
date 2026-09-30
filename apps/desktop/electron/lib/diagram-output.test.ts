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
 * Um bloco ```mermaid tem dois destinos: desenhado (SVG no HTML/PDF, PNG no
 * .docx) quando o main conseguiu renderizar, e bloco de código quando não
 * conseguiu. O desenho em si precisa de DOM e fica fora daqui; o que se testa
 * é o encaixe — que o diagrama entra onde deve e que o .docx continua um
 * pacote válido com a imagem dentro.
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
  it('pega só os blocos mermaid, com a fonte aparada', () => {
    const blocks = parseMarkdown(`${MD}\n\n\`\`\`ts\nconst x = 1\n\`\`\``)
    expect(mermaidSourcesOf(blocks)).toEqual([SOURCE])
  })

  it('bloco mermaid vazio não vai para o renderizador', () => {
    expect(mermaidSourcesOf(parseMarkdown('```mermaid\n```'))).toEqual([])
  })
})

describe('HTML (prévia e PDF)', () => {
  it('embute o SVG no lugar do bloco', () => {
    const html = renderHtml(parseMarkdown(MD), 'Fluxo', undefined, drawn)
    expect(html).toContain('<figure class="diagram">')
    expect(html).toContain(fake.svg)
    expect(html).not.toContain('flowchart LR')
  })

  it('diagrama que não desenhou volta a ser código, sem sumir', () => {
    const html = renderHtml(parseMarkdown(MD), 'Fluxo', undefined, failed)
    expect(html).not.toContain('class="diagram"')
    expect(html).toContain('flowchart LR')
  })

  it('quebra de página pendente vai para o diagrama', () => {
    const blocks = parseMarkdown(`Antes\n\n\\pagebreak\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\``)
    expect(renderHtml(blocks, 'x', undefined, drawn)).toContain('class="diagram page-break"')
  })
})

describe('OOXML', () => {
  it('diagrama registrado vira imagem inline centralizada', () => {
    const xml = renderOoxmlBody(parseMarkdown(MD), undefined, (s) =>
      s === SOURCE ? { rId: 'rId3', width: 400, height: 200 } : undefined,
    )
    expect(xml).toContain('<a:blip r:embed="rId3"/>')
    expect(xml).toContain(`<wp:extent cx="${400 * 9525}" cy="${200 * 9525}"/>`)
    expect(xml).toContain('<w:jc w:val="center"/>')
    expect(xml).not.toContain('flowchart LR')
  })

  it('diagrama largo encolhe para a coluna, mantendo a proporção', () => {
    const xml = renderOoxmlBody(parseMarkdown(MD), { columns: 2 }, () => ({
      rId: 'rId3',
      width: 2000,
      height: 1000,
    }))
    const [, cx, cy] = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/)!.map(Number)
    expect(cx).toBeLessThan(2000 * 9525)
    expect(cx / cy).toBeCloseTo(2, 2)
  })

  it('sem imagem, o bloco sai como código', () => {
    expect(renderOoxmlBody(parseMarkdown(MD))).toContain('flowchart LR')
  })
})

describe('buildDocx', () => {
  it('põe o PNG no pacote, com relacionamento e content type', async () => {
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

  it('a mesma fonte repetida entra uma vez só no pacote', async () => {
    const zip = await JSZip.loadAsync(
      await buildDocx(parseMarkdown(`${MD}\n\n${MD}`), 'x', undefined, drawn),
    )
    expect(Object.keys(zip.files).filter((f) => f.endsWith('.png'))).toEqual([
      'word/media/diagram1.png',
    ])
    const doc = await zip.file('word/document.xml')!.async('string')
    // Cada ocorrência é um desenho próprio (docPr id único), a imagem é a mesma.
    expect(doc.match(/r:embed="rId3"/g)).toHaveLength(2)
    expect(doc).toContain('<wp:docPr id="2"')
  })
})
