import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { docxHeadFoot, withHeadFoot } from './docx-headfoot'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
// PNG 1x1
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`

async function build(opts: { header?: boolean; footer?: boolean }): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`)
  const refs =
    (opts.header ? '<w:headerReference w:type="default" r:id="rId9"/>' : '') +
    (opts.footer ? '<w:footerReference r:id="rId10" w:type="default"/>' : '')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Corpo</w:t></w:r></w:p><w:sectPr>${refs}</w:sectPr></w:body></w:document>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="${REL}/header" Target="header1.xml"/><Relationship Id="rId10" Type="${REL}/footer" Target="footer1.xml"/></Relationships>`)
  zip.file('word/header1.xml', `<?xml version="1.0"?><w:hdr ${W}><w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="logo"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:hdr>`)
  zip.file('word/_rels/header1.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/image" Target="media/logo.png"/></Relationships>`)
  zip.file('word/media/logo.png', PNG)
  zip.file('word/footer1.xml', `<?xml version="1.0"?><w:ftr ${W}><w:p><w:r><w:t>Rodapé institucional</w:t></w:r></w:p></w:ftr>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('docxHeadFoot', () => {
  it('traz a imagem do cabeçalho e o texto do rodapé', async () => {
    const { header, footer } = await docxHeadFoot(await build({ header: true, footer: true }))
    expect(header).toMatch(/<img[^>]+src="data:image\/png;base64,/)
    expect(footer).toContain('Rodapé institucional')
  })

  it('devolve vazio quando a seção não referencia cabeçalho nem rodapé', async () => {
    expect(await docxHeadFoot(await build({}))).toEqual({ header: '', footer: '' })
  })

  it('arquivo que não é docx não derruba nada', async () => {
    expect(await docxHeadFoot(Buffer.from('nada'))).toEqual({ header: '', footer: '' })
  })
})

describe('withHeadFoot', () => {
  it('põe o cabeçalho antes e o rodapé depois do corpo', () => {
    const html = withHeadFoot('<p>x</p>', { header: '<p>h</p>', footer: '<p>f</p>' })
    expect(html.indexOf('<header')).toBeLessThan(html.indexOf('<p>x</p>'))
    expect(html.indexOf('<footer')).toBeGreaterThan(html.indexOf('<p>x</p>'))
  })

  it('não envolve partes ausentes', () => {
    expect(withHeadFoot('<p>x</p>', { header: '', footer: '' })).toBe('<p>x</p>')
  })
})
