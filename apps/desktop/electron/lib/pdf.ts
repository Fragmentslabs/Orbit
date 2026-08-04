// O pdfjs-dist (carregado pelo pdf-parse) exige globals de browser que não
// existem no main process do Electron — sem eles, o módulo lança
// `ReferenceError: DOMMatrix is not defined` no import. O pdfjs tenta fazer o
// polyfill a partir do @napi-rs/canvas, mas num app empacotado o módulo nativo
// pode não estar acessível. Por isso garantimos o polyfill aqui, ANTES de
// carregar o pdf-parse. O import é lazy: só acontece quando houver um PDF de
// verdade, evitando crash no startup do app.
const DATA_URL_PREFIX = /^data:[^;,]*;base64,/

function dataUrlToBytes(url: string): Uint8Array {
  const match = DATA_URL_PREFIX.exec(url)
  if (!match) throw new Error('Formato de data URL inválido para PDF')
  const base64 = url.slice(match[0].length)
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

async function ensurePdfGlobals(): Promise<void> {
  if (globalThis.DOMMatrix) return
  const canvas = await import('@napi-rs/canvas').catch(() => null)
  if (canvas?.DOMMatrix) {
    globalThis.DOMMatrix = canvas.DOMMatrix as unknown as typeof DOMMatrix
    if (!globalThis.ImageData && canvas.ImageData) {
      globalThis.ImageData = canvas.ImageData as unknown as typeof ImageData
    }
    return
  }
  throw new Error(
    'Não foi possível preparar o parser de PDF: DOMMatrix indisponível no main process. Verifique se @napi-rs/canvas está empacotado.'
  )
}

async function loadPdfParse(): Promise<typeof import('pdf-parse').PDFParse> {
  await ensurePdfGlobals()
  const { PDFParse } = await import('pdf-parse')
  return PDFParse
}

export async function extractPdfText(dataUrl: string): Promise<string> {
  const bytes = dataUrlToBytes(dataUrl)
  const PDFParse = await loadPdfParse()
  const parser = new PDFParse(bytes)
  const result = await parser.getText()
  return result.text.trim()
}
