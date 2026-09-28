import { describe, expect, it } from 'vitest'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { sanitizeDocxHtml } from './docx-sanitize'

/**
 * O .docx vem de fora e vira HTML dentro do painel do app. O que se testa é
 * que nada nele chega ativo: link com esquema perigoso, manipulador de evento,
 * script — e que o documento de verdade continua intacto depois da limpeza.
 */

describe('sanitizeDocxHtml', () => {
  it('neutraliza link javascript: e manda os bons para fora do app', () => {
    const html = sanitizeDocxHtml(
      '<p><a href="javascript:alert(1)">clique</a> e <a href="https://exemplo.com">site</a></p>',
    )
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
    expect(html).toContain('href="https://exemplo.com"')
    // target=_blank é o que leva o clique ao handler do main, que só abre
    // http(s) no navegador do sistema.
    expect(html.match(/target="_blank"/g)).toHaveLength(2)
  })

  it('tira manipulador de evento e script', () => {
    const html = sanitizeDocxHtml('<p onclick="roubar()">oi</p><script>alert(1)</script><img src="x" onerror=alert(1)>')
    expect(html).not.toMatch(/onclick|onerror|<script/i)
    expect(html).toContain('<p>oi</p>')
  })

  it('não mexe no que é documento', () => {
    const doc = '<h1>Prova</h1><table><tr><td><p><strong>Nome:</strong> ____</p></td></tr></table>'
    expect(sanitizeDocxHtml(doc)).toBe(doc)
  })

  it('um .docx de verdade sai com título e tabela, e não como linhas soltas', async () => {
    // O mínimo de OOXML que o Word aceita: é o caminho completo, do arquivo
    // ao HTML que o painel desenha.
    const zip = new JSZip()
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    )
    zip.file(
      '_rels/.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    )
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>PLANEJAMENTO</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>DIA</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Conteúdo</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>',
    )
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })

    const { value } = await mammoth.convertToHtml({ buffer })
    const html = sanitizeDocxHtml(value)
    expect(html).toContain('<strong>PLANEJAMENTO</strong>')
    expect(html).toContain('<table>')
    expect(html).toContain('<td><p>DIA</p></td>')
  })
})
