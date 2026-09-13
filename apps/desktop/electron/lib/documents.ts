import { app } from 'electron'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { extractPdfPages } from './pdf'
import type { CellValue } from './sheet-query'
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
 *   - XLSX   → uma página por aba, e a aba grande quebrada em faixas de
 *              linhas (com o cabeçalho repetido em cada faixa)
 *   - DOCX   → páginas sintéticas por tamanho (o formato não guarda paginação)
 */

/**
 * Linhas por página numa planilha. "Página = aba" só funciona enquanto a aba
 * cabe: uma aba de 100 mil linhas precisa ser paginada por dentro, senão o
 * fim dela fica inalcançável — foi assim que a primeira versão truncava em
 * 2000 linhas sem NENHUM offset capaz de chegar no resto.
 */
const ROWS_PER_PAGE = 400

export {
  documentKindOf,
  documentHeader,
  isDocumentPath,
  pageLabel,
  pageLocator,
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

/**
 * Páginas de uma planilha: começa pela aba (a divisão que a planilha já tem,
 * e que deixa o agente pedir "a aba de custos" sem carregar as outras) e
 * quebra a aba em faixas de linhas quando ela é grande.
 *
 * A primeira linha é repetida no topo de cada faixa: sem o cabeçalho, uma
 * faixa do meio vira uma lista de valores sem nome de coluna — o agente leria
 * "1240,BRL,pendente" sem saber o que é cada campo.
 */
function extractSpreadsheetPages(bytes: Buffer): DocumentPage[] {
  const workbook = XLSX.read(bytes, { type: 'buffer' })
  const pages: DocumentPage[] = []

  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
    })
    const asCsv = (row: unknown[]) => row.map(csvCell).join(',')
    const header = rows.length > 0 ? asCsv(rows[0]) : ''

    if (rows.length <= ROWS_PER_PAGE) {
      pages.push({ num: pages.length + 1, label: name, text: rows.map(asCsv).join('\n') })
      continue
    }

    // Aba grande: faixas de linhas, cada uma uma página própria.
    for (let start = 1; start < rows.length; start += ROWS_PER_PAGE) {
      const slice = rows.slice(start, start + ROWS_PER_PAGE)
      const last = Math.min(start + ROWS_PER_PAGE - 1, rows.length - 1)
      pages.push({
        num: pages.length + 1,
        label: `${name}, linhas ${start}-${last} de ${rows.length - 1}`,
        text: [header, ...slice.map(asCsv)].join('\n'),
      })
    }
  }

  return pages
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

/**
 * Linhas TIPADAS de uma aba, para a consulta (sheet_query).
 *
 * Usa `raw: true`, ao contrário da extração de texto: ali o objetivo é o
 * modelo LER, e `raw: false` entrega o valor já formatado como a planilha o
 * exibe; aqui o objetivo é CALCULAR, e número precisa chegar como number —
 * somar a partir do texto formatado reintroduziria o parse de locale
 * ("1.234,56") que é onde mora o erro silencioso.
 *
 * `sheet` ausente = primeira aba, que é o caso da planilha de aba única.
 */
export function readSheetRows(
  bytes: Buffer,
  sheet?: string,
): { rows: CellValue[][]; sheetName: string; sheetNames: string[] } {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true })
  const sheetNames = workbook.SheetNames
  if (sheetNames.length === 0) throw new Error('A planilha não tem nenhuma aba.')

  const wanted = sheet?.trim().toLowerCase()
  const sheetName = wanted
    ? sheetNames.find((n) => n.toLowerCase() === wanted) ?? ''
    : sheetNames[0]
  if (!sheetName) {
    throw new Error(`Aba não encontrada: "${sheet}". Abas disponíveis: ${sheetNames.join(', ')}`)
  }

  const rows = XLSX.utils.sheet_to_json<CellValue[]>(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: null,
  })
  return { rows, sheetName, sheetNames }
}
