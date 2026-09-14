import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'

/**
 * Operações sobre PDFs existentes: juntar, extrair/reordenar/girar páginas,
 * carimbar marca d'água e preencher formulário.
 *
 * Tudo produz um arquivo NOVO — o original nunca é modificado, pela mesma
 * regra da edição de .docx: o usuário anexou um documento, não autorizou
 * mexer nele.
 *
 * Módulo puro de bytes (sem Electron, sem IO), para ser testável.
 */

/** Teto de páginas por PDF gerado — evita que um pedido errado gere um
 *  arquivo absurdo a partir de um documento grande. */
const MAX_PAGES = 2000

export interface PdfMetadata {
  title?: string
  author?: string
  subject?: string
  keywords?: string
}

/** Metadados atuais do arquivo — o que aparece em Propriedades no leitor. */
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
  // O pdf-lib espera lista; uma string com virgulas viraria UMA palavra-chave.
  if (meta.keywords !== undefined) {
    doc.setKeywords(meta.keywords.split(',').map((k) => k.trim()).filter(Boolean))
  }
  doc.setModificationDate(new Date())
}

export interface PageSelection {
  /** Páginas 1-indexadas, na ORDEM pedida — é o que permite reordenar, e não
   *  só filtrar. Ausente = todas. */
  pages?: number[]
  /** Rotação em graus, aplicada às páginas selecionadas (90, 180, 270). */
  rotate?: number
  watermark?: string
  metadata?: PdfMetadata
}

/**
 * Expande uma seleção tipo "1-3,7,10-12" em números de página.
 *
 * Aceitar intervalo importa: pedir 40 páginas uma a uma seria caro em tokens
 * e o modelo erra a lista no meio.
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
      // Intervalo invertido ("9-3") é lido como contagem regressiva em vez de
      // devolver nada — é o que o usuário quis dizer.
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
    // Diagonal, centralizada e translúcida: atravessa o conteúdo sem
    // escondê-lo, que é o ponto de uma marca d'água.
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

/** Junta vários PDFs num só, na ordem recebida. */
export async function mergePdfs(sources: Buffer[]): Promise<{ bytes: Buffer; pages: number }> {
  if (sources.length === 0) throw new Error('Nenhum PDF para juntar.')
  const out = await PDFDocument.create()
  for (const source of sources) {
    const doc = await PDFDocument.load(source)
    const copied = await out.copyPages(doc, doc.getPageIndices())
    for (const page of copied) out.addPage(page)
    if (out.getPageCount() > MAX_PAGES) throw new Error(`Resultado passaria de ${MAX_PAGES} páginas.`)
  }
  const bytes = Buffer.from(await out.save())
  return { bytes, pages: out.getPageCount() }
}

/**
 * Extrai/reordena/gira páginas e opcionalmente carimba. Quando `pages` é
 * omitido mantém o documento inteiro — assim a mesma tool serve para "só
 * gire" ou "só carimbe".
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
    if (indices.length === 0) throw new Error(`Nenhuma página válida (o documento tem ${total}).`)
    const copied = await out.copyPages(doc, indices)
    for (const page of copied) out.addPage(page)
  } else {
    out = doc
  }

  if (selection.rotate) {
    // Soma à rotação que a página já tinha: girar 90 num documento que já
    // vinha deitado deve resultar em 180, não voltar para 90.
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

/** Campos de formulário do PDF, para o agente saber o que preencher. */
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
      // campo exótico: o nome e o tipo já bastam para o agente decidir
    }
    return base
  })
}

/**
 * Preenche campos pelo nome. `flatten` torna o resultado não editável — é o
 * que se quer ao ENVIAR o formulário preenchido, e o contrário do que se quer
 * ao devolvê-lo para alguém continuar preenchendo.
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
      // Chamar como método, e não `(cond ? a.check : a.uncheck)()`: aquela
      // forma desacopla a função do objeto e o `this` some — a caixa nunca
      // era marcada e o campo aparecia como "não encontrado".
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
      // Campo inexistente não derruba o preenchimento inteiro: o agente
      // recebe a lista do que falhou e corrige com readFormFields.
      missing.push(name)
    }
  }

  if (flatten) form.flatten()
  return { bytes: Buffer.from(await doc.save()), filled, missing }
}
