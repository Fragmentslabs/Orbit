import { describe, expect, it } from 'vitest'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { sanitizeDocxHtml } from './docx-sanitize'

/**
 * The .docx comes from outside and becomes HTML inside the app's panel. What is tested is
 * that nothing in it arrives active: a link with a dangerous scheme, an event handler,
 * script — and that the real document stays intact after the
 * cleanup.
 */

describe('sanitizeDocxHtml', () => {
  it('neutralizes a javascript: link and sends the good ones out of the app', () => {
    const html = sanitizeDocxHtml(
      '<p><a href="javascript:alert(1)">click</a> and <a href="https://example.com">site</a></p>',
    )
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
    expect(html).toContain('href="https://example.com"')
    // target=_blank is what takes the click to the main's handler, which only opens
    // http(s) in the system browser.
    expect(html.match(/target="_blank"/g)).toHaveLength(2)
  })

  it('removes event handler and script', () => {
    const html = sanitizeDocxHtml('<p onclick="roubar()">hi</p><script>alert(1)</script><img src="x" onerror=alert(1)>')
    expect(html).not.toMatch(/onclick|onerror|<script/i)
    expect(html).toContain('<p>hi</p>')
  })

  it('does not touch what is a document', () => {
    const doc = '<h1>Exam</h1><table><tr><td><p><strong>Name:</strong> ____</p></td></tr></table>'
    expect(sanitizeDocxHtml(doc)).toBe(doc)
  })

  it('a real .docx comes out with heading and table, not as loose lines', async () => {
    // The minimum OOXML Word accepts: it is the complete path, from the file
    // to the HTML the panel draws.
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
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>PLANNING</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>DAY</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Content</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>',
    )
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })

    const { value } = await mammoth.convertToHtml({ buffer })
    const html = sanitizeDocxHtml(value)
    expect(html).toContain('<strong>PLANNING</strong>')
    expect(html).toContain('<table>')
    expect(html).toContain('<td><p>DAY</p></td>')
  })
})
