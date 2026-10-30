import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'

/**
 * Operations on existing PDFs: merge, extract/reorder/rotate pages,
 * stamp a watermark and fill in a form.
 *
 * Everything produces a NEW file — the original is never modified, by the same
 * rule as .docx editing: the user attached a document, they did not authorize
 * touching it.
 *
 * Pure bytes module (no Electron, no IO), to be testable.
 */

/** Page ceiling per generated PDF — it keeps a wrong request from generating an
 *  absurd file out of a large document. */
const MAX_PAGES = 2000

export interface PdfMetadata {
  title?: string
  author?: string
  subject?: string
  keywords?: string
}

/** Current metadata of the file — what shows up under Properties in the reader. */
export async function readMetadata(source: Buffer): Promise<Record<string, string | undefined>> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true })
  const date = (d: Date | undefined) => (d ? d.toISOString().slice(0, 10) : undefined)
  return {
    title: doc.getTitle(),
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    keywords: doc.getKeywords(),
    creator: doc.getCreator(),
    producer: doc.getProducer(),
    createdAt: date(doc.getCreationDate()),
    modifiedAt: date(doc.getModificationDate()),
    pages: String(doc.getPageCount()),
  }
}

function applyMetadata(doc: PDFDocument, meta: PdfMetadata): void {
  if (meta.title !== undefined) doc.setTitle(meta.title)
  if (meta.author !== undefined) doc.setAuthor(meta.author)
  if (meta.subject !== undefined) doc.setSubject(meta.subject)
  // pdf-lib expects a list; a string with commas would become ONE keyword.
  if (meta.keywords !== undefined) {
    doc.setKeywords(meta.keywords.split(',').map((k) => k.trim()).filter(Boolean))
  }
  doc.setModificationDate(new Date())
}

export interface PageSelection {
  /** 1-indexed pages, in the ORDER requested — it is what allows reordering, and not
   *  just filtering. Absent = all. */
  pages?: number[]
  /** Rotation in degrees, applied to the selected pages (90, 180, 270). */
  rotate?: number
  watermark?: string
  metadata?: PdfMetadata
}

/**
 * Expands a selection like "1-3,7,10-12" into page numbers.
 *
 * Accepting ranges matters: asking for 40 pages one by one would be expensive in tokens
 * and the model gets the list wrong in the middle.
 */
export function parsePageRange(spec: string, total: number): number[] {
  const out: number[] = []
  for (const part of spec.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      // An inverted range ("9-3") is read as a countdown instead of
      // returning nothing — it is what the user meant.
      const step = from <= to ? 1 : -1
      for (let n = from; step > 0 ? n <= to : n >= to; n += step) {
        if (n >= 1 && n <= total) out.push(n)
      }
      continue
    }
    const single = Number(trimmed)
    if (Number.isInteger(single) && single >= 1 && single <= total) out.push(single)
  }
  return out.slice(0, MAX_PAGES)
}

async function stampWatermark(doc: PDFDocument, text: string): Promise<void> {
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    // Diagonal, centered and translucent: it goes across the content without
    // hiding it, which is the point of a watermark.
    const size = Math.min(width, height) / Math.max(8, text.length) * 2.2
    page.drawText(text, {
      x: width * 0.12,
      y: height * 0.42,
      size,
      font,
      color: rgb(0.6, 0.6, 0.6),
      opacity: 0.28,
      rotate: degrees(38),
    })
  }
}

/** Merges several PDFs into one, in the order received. */
export async function mergePdfs(sources: Buffer[]): Promise<{ bytes: Buffer; pages: number }> {
  if (sources.length === 0) throw new Error('No PDFs to merge.')
  const out = await PDFDocument.create()
  for (const source of sources) {
    const doc = await PDFDocument.load(source)
    const copied = await out.copyPages(doc, doc.getPageIndices())
    for (const page of copied) out.addPage(page)
    if (out.getPageCount() > MAX_PAGES) throw new Error(`The result would exceed ${MAX_PAGES} pages.`)
  }
  const bytes = Buffer.from(await out.save())
  return { bytes, pages: out.getPageCount() }
}

/**
 * Extracts/reorders/rotates pages and optionally stamps. When `pages` is
 * omitted it keeps the whole document — that way the same tool serves "just
 * rotate it" or "just stamp it".
 */
export async function transformPdf(
  source: Buffer,
  selection: PageSelection,
): Promise<{ bytes: Buffer; pages: number; total: number }> {
  const doc = await PDFDocument.load(source)
  const total = doc.getPageCount()
  const wanted = selection.pages?.length ? selection.pages : null

  let out: PDFDocument
  if (wanted) {
    out = await PDFDocument.create()
    const indices = wanted.filter((n) => n >= 1 && n <= total).map((n) => n - 1)
    if (indices.length === 0) throw new Error(`No valid pages (the document has ${total}).`)
    const copied = await out.copyPages(doc, indices)
    for (const page of copied) out.addPage(page)
  } else {
    out = doc
  }

  if (selection.rotate) {
    // Adds to the rotation the page already had: rotating 90 a document that already
    // came sideways must result in 180, not go back to 90.
    const delta = ((Math.round(selection.rotate / 90) * 90) % 360 + 360) % 360
    if (delta !== 0) {
      for (const page of out.getPages()) {
        page.setRotation(degrees((page.getRotation().angle + delta) % 360))
      }
    }
  }
  if (selection.watermark) await stampWatermark(out, selection.watermark)
  if (selection.metadata) applyMetadata(out, selection.metadata)

  const bytes = Buffer.from(await out.save())
  return { bytes, pages: out.getPageCount(), total }
}

export interface FormField {
  name: string
  type: string
  value?: string
  options?: string[]
}

/** Form fields of the PDF, so the agent knows what to fill in. */
export async function readFormFields(source: Buffer): Promise<FormField[]> {
  const doc = await PDFDocument.load(source)
  const form = doc.getForm()
  return form.getFields().map((field) => {
    const type = field.constructor.name.replace(/^PDF/, '')
    const base: FormField = { name: field.getName(), type }
    try {
      const anyField = field as unknown as {
        getText?: () => string | undefined
        isChecked?: () => boolean
        getSelected?: () => string[]
        getOptions?: () => string[]
      }
      if (anyField.getText) base.value = anyField.getText()
      else if (anyField.isChecked) base.value = anyField.isChecked() ? 'true' : 'false'
      else if (anyField.getSelected) base.value = anyField.getSelected()?.join(', ')
      if (anyField.getOptions) base.options = anyField.getOptions()
    } catch {
      // exotic field: the name and the type are already enough for the agent to decide
    }
    return base
  })
}

/**
 * Fills fields by name. `flatten` makes the result non-editable — it is what
 * you want when SENDING the filled form, and the opposite of what you want
 * when handing it back for someone to keep filling in.
 */
export async function fillForm(
  source: Buffer,
  values: Record<string, string>,
  flatten = false,
): Promise<{ bytes: Buffer; filled: string[]; missing: string[] }> {
  const doc = await PDFDocument.load(source)
  const form = doc.getForm()
  const filled: string[] = []
  const missing: string[] = []

  for (const [name, value] of Object.entries(values)) {
    try {
      const field = form.getField(name)
      const anyField = field as unknown as {
        setText?: (v: string) => void
        check?: () => void
        uncheck?: () => void
        select?: (v: string) => void
      }
      const truthy = /^(true|sim|yes|x|1|on)$/i.test(value.trim())
      if (anyField.setText) anyField.setText(value)
      // Calling as a method, and not `(cond ? a.check : a.uncheck)()`: that
      // form detaches the function from the object and `this` disappears — the box was never
      // marked and the field showed up as "not found".
      else if (anyField.check && anyField.uncheck) {
        if (truthy) anyField.check()
        else anyField.uncheck()
      } else if (anyField.select) anyField.select(value)
      else {
        missing.push(name)
        continue
      }
      filled.push(name)
    } catch {
      // A nonexistent field does not bring the whole filling down: the agent
      // receives the list of what failed and corrects it with readFormFields.
      missing.push(name)
    }
  }

  if (flatten) form.flatten()
  return { bytes: Buffer.from(await doc.save()), filled, missing }
}
