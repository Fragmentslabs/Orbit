import { PDFParse } from 'pdf-parse'

// O mime embutido na data URL vem do sniff do browser no drop/seleção do
// arquivo (File.type) — nem sempre é "application/pdf" exato (drag-and-drop
// nativo do Electron às vezes não popula ou popula com outro valor). A
// detecção de que É um PDF já aconteceu antes de chamar esta função (mime OU
// extensão .pdf), então aqui só precisamos separar o base64 do prefixo,
// sem exigir um mime específico — mesmo padrão usado em xlsx.ts/docx.ts.
const DATA_URL_PREFIX = /^data:[^;,]*;base64,/

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
