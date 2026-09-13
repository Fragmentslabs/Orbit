import { app } from 'electron'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { extractPdfPages } from './pdf'
import {
  capPages,
  documentKindOf,
  paginateText,
  type DocumentKind,
  type DocumentPage,
  type ExtractedDocument,
} from './document-pages'

/**
 * Camada de texto dos documentos (PDF, DOCX, planilhas) — extração e cache.
 * As decisões de paginação ficam no document-pages.ts (puro e testado).
 *
 * Antes desta camada, documento só existia como ANEXO: o texto inteiro era
 * extraído e colado na mensagem, e o toModelMessages o reenviava a cada turno
 * — um PDF de 300 páginas ocupava a janela de contexto para sempre. E no modo
 * código o agente era simplesmente cego: `read` faz readFile(file, 'utf8'), o
 * que num PDF devolve binário, e `grep` pula qualquer arquivo com \0.
 *
 * A saída é sempre PAGINADA. Página é a unidade de leitura porque é a unidade
 * que o usuário e o documento já usam ("está na página 40"), e é o que permite
 * ler um trecho sem carregar o resto:
 *
 *   - PDF    → páginas reais (pdf-parse devolve pages[])
 *   - XLSX   → uma página por aba (a divisão natural da planilha)
 *   - DOCX   → páginas sintéticas por tamanho (o formato não guarda paginação)
 */

const MAX_ROWS_PER_SHEET = 2000

export {
  documentKindOf,
  documentHeader,
  isDocumentPath,
  pageLabel,
  pageWindow,
} from './document-pages'
export type { DocumentKind, DocumentPage, ExtractedDocument } from './document-pages'

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'doc-cache')
}

function csvCell(value: unknown): string {
  const s = String(value ?? '')
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Uma página por aba: é como a planilha já se organiza, e deixa o agente
 *  pedir "a aba de custos" sem carregar as outras. */
function extractSpreadsheetPages(bytes: Buffer): DocumentPage[] {
  const workbook = XLSX.read(bytes, { type: 'buffer' })
  return workbook.SheetNames.map((name, index) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
    })
    const body = rows
      .slice(0, MAX_ROWS_PER_SHEET)
      .map((row) => row.map(csvCell).join(','))
      .join('\n')
    const note =
      rows.length > MAX_ROWS_PER_SHEET
        ? `\n_(primeiras ${MAX_ROWS_PER_SHEET} de ${rows.length} linhas)_`
        : ''
    return { num: index + 1, label: name, text: `${body}${note}` }
  })
}

async function extractFresh(bytes: Buffer, kind: DocumentKind): Promise<ExtractedDocument> {
  if (kind === 'pdf') return capPages(await extractPdfPages(bytes), kind)
  if (kind === 'spreadsheet') return capPages(extractSpreadsheetPages(bytes), kind)
  const result = await mammoth.extractRawText({ buffer: bytes })
  return capPages(paginateText(result.value.trim()), kind)
}

/**
 * Extrai com cache em disco. Extrair é caro — segundos num PDF grande — e o
 * agente relê o mesmo arquivo várias vezes no mesmo turno (grep localiza,
 * read confirma, read continua).
 *
 * A chave é o HASH DO CONTEÚDO, não o caminho: arquivo renomeado ou movido
 * reaproveita o cache, e arquivo editado o invalida sozinho — sem depender de
 * mtime, que muda em checkout e não muda em edição preservando timestamp.
 */
export async function extractDocument(bytes: Buffer, kind: DocumentKind): Promise<ExtractedDocument> {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  const file = path.join(cacheDir(), `${hash}.json`)

  try {
    const cached = JSON.parse(await fsp.readFile(file, 'utf8')) as ExtractedDocument
    if (Array.isArray(cached.pages)) return cached
  } catch {
    // sem cache (ou corrompido) — extrai de novo
  }

  const extracted = await extractFresh(bytes, kind)
  try {
    await fsp.mkdir(cacheDir(), { recursive: true })
    await fsp.writeFile(file, JSON.stringify(extracted), 'utf8')
  } catch {
    // cache é otimização: falhar ao gravar não invalida o resultado
  }
  return extracted
}

/** Extrai um documento do disco (modo código: arquivo dentro do repositório). */
export async function extractDocumentFile(filePath: string): Promise<ExtractedDocument> {
  const kind = documentKindOf(filePath)
  if (!kind) throw new Error(`Não é um documento suportado: ${path.basename(filePath)}`)
  return extractDocument(await fsp.readFile(filePath), kind)
}
