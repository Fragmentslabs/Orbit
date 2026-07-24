import { PDFParse } from 'pdf-parse'

const DATA_URL_PREFIX = /^data:application\/pdf;base64,/

function dataUrlToBytes(url: string): Uint8Array {
  const match = DATA_URL_PREFIX.exec(url)
  if (!match) throw new Error('Formato de data URL inválido para PDF')
  const base64 = url.slice(match[0].length)
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

export async function extractPdfText(dataUrl: string): Promise<string> {
  const bytes = dataUrlToBytes(dataUrl)
  const parser = new PDFParse(bytes)
  const result = await parser.getText()
  return result.text.trim()
}
