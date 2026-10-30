import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { splitDocxPages } from '@shared/page-breaks'
import { docxFileToHtml, normalizePageBreaks } from './docx-view'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`

async function build(body: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return (await zip.file('word/document.xml')!.async('string')) ?? ''
}

let folder: string | null = null

/** The same .docx on disk, which is how the panel delivers it to mammoth. */
async function toFile(body: string): Promise<string> {
  folder ??= await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-docx-view-'))
  const file = path.join(folder, `${Math.random().toString(36).slice(2)}.docx`)
  await fsp.writeFile(file, await build(body))
  return file
}

afterAll(async () => {
  if (folder) await fsp.rm(folder, { recursive: true, force: true })
})

describe('normalizePageBreaks', () => {
  it('converts the pPr break into the run break mammoth understands', async () => {
    const buffer = await build(
      '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>After</w:t></w:r></w:p>',
    )
    const xml = await documentXml(await normalizePageBreaks(buffer))
    expect(xml).not.toContain('<w:pageBreakBefore')
    // The break enters as the paragraph's FIRST run — not before it, which
    // would leave one extra blank page.
    expect(xml).toContain('<w:pPr></w:pPr><w:r><w:br w:type="page"/></w:r><w:r><w:t>After')
  })

  it('returns the buffer itself when there is no pPr break', async () => {
    const buffer = await build('<w:p><w:r><w:t>One</w:t></w:r></w:p>')
    expect(await normalizePageBreaks(buffer)).toBe(buffer)
  })

  it('does not ruin a package that is not a .docx', async () => {
    const buffer = Buffer.from('this is not a zip')
    expect(await normalizePageBreaks(buffer)).toBe(buffer)
  })
})

describe('docxFileToHtml — breaks', () => {
  it('the pPr break becomes one more sheet', async () => {
    const file = await toFile(
      '<w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Two</w:t></w:r></w:p>',
    )
    const result = await docxFileToHtml(file)
    expect(result).not.toBeNull()
    const sheets = splitDocxPages(result!.html)
    expect(sheets).toHaveLength(2)
    expect(sheets[0]).toContain('One')
    expect(sheets[0]).not.toContain('Two')
    expect(sheets[1]).toContain('Two')
  })

  it('the run break (Ctrl+Enter) also separates', async () => {
    const file = await toFile(
      '<w:p><w:r><w:t>One</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p>',
    )
    const sheets = splitDocxPages((await docxFileToHtml(file))!.html)
    expect(sheets).toHaveLength(2)
    expect(sheets[1]).toContain('Two')
  })

  it('without a break, the document stays a single sheet', async () => {
    const file = await toFile('<w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p>')
    const sheets = splitDocxPages((await docxFileToHtml(file))!.html)
    expect(sheets).toHaveLength(1)
    expect(sheets[0]).toContain('One')
    expect(sheets[0]).toContain('Two')
  })
})
