// O pdfjs-dist (carregado pelo pdf-parse) exige globals de browser que não
// existem no main process do Electron — sem eles, o módulo lança
// `ReferenceError: DOMMatrix is not defined` no import. O pdfjs tenta fazer o
// polyfill a partir do @napi-rs/canvas, mas num app empacotado o módulo nativo
// pode não estar acessível. Por isso garantimos o polyfill aqui, ANTES de
// carregar o pdf-parse. O import é lazy: só acontece quando houver um PDF de
// verdade, evitando crash no startup do app.
async function ensurePdfGlobals(): Promise<void> {
  if (globalThis.DOMMatrix) return
  const canvas = await import('@napi-rs/canvas').catch(() => null)
  if (canvas?.DOMMatrix) {
    globalThis.DOMMatrix = canvas.DOMMatrix as unknown as typeof DOMMatrix
    if (!globalThis.ImageData && canvas.ImageData) {
      globalThis.ImageData = canvas.ImageData as unknown as typeof ImageData
    }
    // A rasterização desenha caminhos vetoriais — sem Path2D o pdfjs falha em
    // páginas com traçado, que é a maioria das que têm tabela ou moldura.
    const withPath = canvas as unknown as { Path2D?: typeof Path2D }
    if (!globalThis.Path2D && withPath.Path2D) {
      globalThis.Path2D = withPath.Path2D
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

/**
 * Texto POR PÁGINA — a unidade que a camada de documentos usa para servir um
 * trecho sem carregar o resto (ver documents.ts). O pdf-parse já devolve
 * `pages[]`; páginas vazias (só imagem, sem camada de texto) são preservadas
 * para a numeração continuar batendo com a do documento real.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<{ num: number; text: string }[]> {
  const PDFParse = await loadPdfParse()
  const parser = new PDFParse(bytes)
  const result = await parser.getText()
  return result.pages.map((page) => ({ num: page.num, text: page.text.trim() }))
}
