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

/** O mesmo .docx em disco, que é como o painel o entrega ao mammoth. */
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
  it('converte a quebra do pPr na quebra de run que o mammoth entende', async () => {
    const buffer = await build(
      '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Depois</w:t></w:r></w:p>',
    )
    const xml = await documentXml(await normalizePageBreaks(buffer))
    expect(xml).not.toContain('<w:pageBreakBefore')
    // A quebra entra como PRIMEIRO run do parágrafo — não antes dele, que
    // deixaria uma página em branco a mais.
    expect(xml).toContain('<w:pPr></w:pPr><w:r><w:br w:type="page"/></w:r><w:r><w:t>Depois')
  })

  it('devolve o próprio buffer quando não há quebra de pPr', async () => {
    const buffer = await build('<w:p><w:r><w:t>Um</w:t></w:r></w:p>')
    expect(await normalizePageBreaks(buffer)).toBe(buffer)
  })

  it('não estraga um pacote que não é .docx', async () => {
    const buffer = Buffer.from('isto não é um zip')
    expect(await normalizePageBreaks(buffer)).toBe(buffer)
  })
})

describe('docxFileToHtml — quebras', () => {
  it('a quebra do pPr vira uma folha a mais', async () => {
    const file = await toFile(
      '<w:p><w:r><w:t>Um</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Dois</w:t></w:r></w:p>',
    )
    const result = await docxFileToHtml(file)
    expect(result).not.toBeNull()
    const folhas = splitDocxPages(result!.html)
    expect(folhas).toHaveLength(2)
    expect(folhas[0]).toContain('Um')
    expect(folhas[0]).not.toContain('Dois')
    expect(folhas[1]).toContain('Dois')
  })

  it('a quebra de run (Ctrl+Enter) também separa', async () => {
    const file = await toFile(
      '<w:p><w:r><w:t>Um</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Dois</w:t></w:r></w:p>',
    )
    const folhas = splitDocxPages((await docxFileToHtml(file))!.html)
    expect(folhas).toHaveLength(2)
    expect(folhas[1]).toContain('Dois')
  })

  it('sem quebra, o documento continua uma folha só', async () => {
    const file = await toFile('<w:p><w:r><w:t>Um</w:t></w:r></w:p><w:p><w:r><w:t>Dois</w:t></w:r></w:p>')
    const folhas = splitDocxPages((await docxFileToHtml(file))!.html)
    expect(folhas).toHaveLength(1)
    expect(folhas[0]).toContain('Um')
    expect(folhas[0]).toContain('Dois')
  })
})
