import * as XLSX from 'xlsx'

const DATA_URL_PREFIX = /^data:[^;,]*;base64,/

function dataUrlToBuffer(url: string): Buffer {
  const match = DATA_URL_PREFIX.exec(url)
  if (!match) throw new Error('Formato de data URL inválido para planilha')
  return Buffer.from(url.slice(match[0].length), 'base64')
}

function csvCell(value: unknown): string {
  const s = String(value ?? '')
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const MAX_ROWS_PER_SHEET = 500
const MAX_CHARS = 30000

/** Converte uma planilha anexada (.xls, .xlsx, .ods, .csv) em CSV por aba,
 * legível pelo modelo. Limita linhas/tamanho para não estourar o payload. */
export async function extractSpreadsheetText(dataUrl: string): Promise<string> {
  const buffer = dataUrlToBuffer(dataUrl)
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sheetNames = workbook.SheetNames
  if (sheetNames.length === 0) return '(planilha vazia — nenhuma aba encontrada)'

  const blocks: string[] = []
  let total = 0
  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' })
    const truncatedRows = rows.length > MAX_ROWS_PER_SHEET
    const csv = rows
      .slice(0, MAX_ROWS_PER_SHEET)
      .map((row) => row.map(csvCell).join(','))
      .join('\n')
    const header = sheetNames.length > 1 ? `### Aba: ${name}\n` : ''
    const note = truncatedRows ? `\n_(mostrando as primeiras ${MAX_ROWS_PER_SHEET} de ${rows.length} linhas)_` : ''
    const block = `${header}${csv}${note}`
    total += block.length
    blocks.push(block)
    if (total > MAX_CHARS) {
      blocks.push('\n_(demais abas omitidas — arquivo muito grande)_')
      break
    }
  }
  return blocks.join('\n\n').slice(0, MAX_CHARS)
}
