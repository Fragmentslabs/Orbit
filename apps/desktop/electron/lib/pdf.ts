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
 * Abre o documento. Um ponto só de entrada de propósito: o construtor recebe
 * OPÇÕES, não os bytes, e passar os bytes direto compila — `Uint8Array` tem
 * `length`, `LoadParameters.length?` também, e o TypeScript aceita a
 * atribuição. O resultado era `data: undefined` e o pdfjs recusando com
 * "Please provide binary data as Uint8Array, rather than Buffer" em todo PDF,
 * anexo ou do repositório.
 *
 * A cópia dos bytes não é desperdício: o pdfjs TRANSFERE o array para o
 * worker e pode desanexá-lo, e quem chama ainda usa o mesmo Buffer depois
 * (o anexo grava o arquivo original em disco logo após extrair o texto).
 */
async function openPdf(bytes: Uint8Array): Promise<InstanceType<typeof import('pdf-parse').PDFParse>> {
  const PDFParse = await loadPdfParse()
  return new PDFParse({ data: new Uint8Array(bytes) })
}

/**
 * Texto POR PÁGINA — a unidade que a camada de documentos usa para servir um
 * trecho sem carregar o resto (ver documents.ts). O pdf-parse já devolve
 * `pages[]`; páginas vazias (só imagem, sem camada de texto) são preservadas
 * para a numeração continuar batendo com a do documento real.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<{ num: number; text: string }[]> {
  const parser = await openPdf(bytes)
  try {
    const result = await parser.getText()
    return result.pages.map((page) => ({ num: page.num, text: page.text.trim() }))
  } finally {
    // Cada parser segura um documento do pdfjs; sem isto, um anexo por
    // conversa acumularia no main process pelo resto da sessão.
    await parser.destroy().catch(() => {})
  }
}

/**
 * Imagens EMBUTIDAS no PDF (as figuras de verdade, não a página renderizada).
 *
 * É o complemento da rasterização: `rasterizePdf` devolve uma foto da página
 * inteira; isto devolve a foto que estava dentro dela, no tamanho e na
 * qualidade originais — que é o que serve para reaproveitar um gráfico, um
 * logotipo ou a digitalização de uma assinatura.
 */
export const DEFAULT_IMAGE_MIN_SIZE = 80

export async function extractPdfImages(
  bytes: Uint8Array,
  options: { pages?: number[]; max?: number; minSize?: number } = {},
): Promise<{ pageNumber: number; name: string; png: Buffer; width: number; height: number }[]> {
  const parser = await openPdf(bytes)
  // O piso existe para não devolver os cacos decorativos (régua, fio, pixel de
  // fundo) que todo PDF diagramado tem às dezenas. Fica explícito aqui, e não
  // no default silencioso da lib, porque é a diferença entre "este PDF não tem
  // figura" e "a figura que você quer é menor que o piso" — e quem chama
  // precisa poder baixá-lo para ir buscar um logotipo pequeno.
  const result = await parser
    .getImage({ imageThreshold: Math.max(0, options.minSize ?? DEFAULT_IMAGE_MIN_SIZE) })
    .finally(() => parser.destroy().catch(() => {}))
  const max = Math.max(1, options.max ?? 20)
  const wanted = options.pages?.length ? new Set(options.pages) : null

  const out: { pageNumber: number; name: string; png: Buffer; width: number; height: number }[] = []
  for (const page of result.pages ?? []) {
    if (wanted && !wanted.has(page.pageNumber)) continue
    for (const image of page.images ?? []) {
      if (out.length >= max) return out
      const data = image.data as unknown as Uint8Array | undefined
      if (!data || data.length === 0) continue
      out.push({
        pageNumber: page.pageNumber,
        name: String(image.name ?? `img${out.length + 1}`),
        png: Buffer.from(data),
        width: Number(image.width ?? 0),
        height: Number(image.height ?? 0),
      })
    }
  }
  return out
}
