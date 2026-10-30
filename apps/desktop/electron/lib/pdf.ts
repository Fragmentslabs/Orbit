// pdfjs-dist (loaded by pdf-parse) requires browser globals that do not
// exist in Electron's main process — without them, the module throws
// `ReferenceError: DOMMatrix is not defined` on import. pdfjs tries to
// polyfill from @napi-rs/canvas, but in a packaged app the native module
// may not be accessible. That is why we guarantee the polyfill here, BEFORE
// loading pdf-parse. The import is lazy: it only happens when there really is
// a PDF, avoiding a crash at the app startup.
async function ensurePdfGlobals(): Promise<void> {
  if (globalThis.DOMMatrix) return
  const canvas = await import('@napi-rs/canvas').catch(() => null)
  if (canvas?.DOMMatrix) {
    globalThis.DOMMatrix = canvas.DOMMatrix as unknown as typeof DOMMatrix
    if (!globalThis.ImageData && canvas.ImageData) {
      globalThis.ImageData = canvas.ImageData as unknown as typeof ImageData
    }
    // Rasterization draws vector paths — without Path2D pdfjs fails on
    // pages with strokes, which is most of those with a table or a frame.
    const withPath = canvas as unknown as { Path2D?: typeof Path2D }
    if (!globalThis.Path2D && withPath.Path2D) {
      globalThis.Path2D = withPath.Path2D
    }
    return
  }
  throw new Error(
    'Could not prepare the PDF parser: DOMMatrix unavailable in the main process. Check whether @napi-rs/canvas is inpacotado.'
  )
}

async function loadPdfParse(): Promise<typeof import('pdf-parse').PDFParse> {
  await ensurePdfGlobals()
  const { PDFParse } = await import('pdf-parse')
  return PDFParse
}

/**
 * Opens the document. A single entry point on purpose: the constructor receives
 * OPTIONS, not the bytes, and passing the bytes directly compiles — `Uint8Array` has
 * `length`, `LoadParameters.length?` does too, and TypeScript accepts the
 * assignment. The result was `data: undefined` and pdfjs refusing with
 * "Please provide binary data as Uint8Array, rather than Buffer" on every PDF,
 * attachment or from the repository.
 *
 * Copying the bytes is not waste: pdfjs TRANSFERS the array to the
 * worker and may detach it, and whoever calls still uses the same Buffer afterwards
 * (the attachment writes the original file to disk right after extracting the text).
 */
async function openPdf(bytes: Uint8Array): Promise<InstanceType<typeof import('pdf-parse').PDFParse>> {
  const PDFParse = await loadPdfParse()
  return new PDFParse({ data: new Uint8Array(bytes) })
}

/**
 * Text PER PAGE — the unit the document layer uses to serve a
 * stretch without loading the rest (see documents.ts). pdf-parse already returns
 * `pages[]`; empty pages (image only, without a text layer) are preserved
 * so that the numbering keeps matching the real document's.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<{ num: number; text: string }[]> {
  const parser = await openPdf(bytes)
  try {
    const result = await parser.getText()
    return result.pages.map((page) => ({ num: page.num, text: page.text.trim() }))
  } finally {
    // Each parser holds a pdfjs document; without this, one attachment per
    // conversation would pile up in the main process for the rest of the session.
    await parser.destroy().catch(() => {})
  }
}

/**
 * Images EMBEDDED in the PDF (the real figures, not the rendered page).
 *
 * It is the complement of rasterization: `rasterizePdf` returns a photo of the whole
 * page; this returns the photo that was inside it, at the original size and
 * quality — which is what serves to reuse a chart, a
 * logo or the scan of a signature.
 */
export const DEFAULT_IMAGE_MIN_SIZE = 80

export async function extractPdfImages(
  bytes: Uint8Array,
  options: { pages?: number[]; max?: number; minSize?: number } = {},
): Promise<{ pageNumber: number; name: string; png: Buffer; width: number; height: number }[]> {
  const parser = await openPdf(bytes)
  // The floor exists so as not to return the decorative crumbs (ruler, line, background
  // pixel) that every laid-out PDF has by the dozens. It is explicit here, and not
  // in the lib's silent default, because it is the difference between "this PDF has no
  // figure" and "the figure you want is smaller than the floor" — and whoever calls
  // has to be able to lower it to go fetch a small logo.
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
