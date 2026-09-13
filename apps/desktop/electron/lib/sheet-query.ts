/**
 * Consulta declarativa sobre linhas de planilha: filtrar, agrupar, somar.
 *
 * Existe porque ler a planilha e somar "na cabeça" é caro E ERRADO. O modelo
 * percorrendo 5.000 linhas gasta contexto proporcional ao tamanho do arquivo
 * e erra a aritmética de um jeito silencioso — a resposta sai com a mesma cara
 * de confiança de uma resposta certa. Aqui o número é calculado, não estimado.
 *
 * É DECLARATIVO de propósito, e não "execute este código": no modo chat não há
 * sandbox, e rodar código arbitrário no processo main é outro modelo de ameaça
 * inteiro. Quem precisa de código arbitrário está no modo código e já tem bash.
 *
 * Módulo puro (sem Electron, sem IO) para ser testável — mesma divisão do
 * document-pages.ts.
 */

export type CellValue = string | number | boolean | Date | null

export type CompareOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'empty'
  | 'notEmpty'

export interface Condition {
  column: string
  op: CompareOp
  /** Dispensado em `empty`/`notEmpty`. */
  value?: string | number | boolean
}

export type AggregateFn = 'sum' | 'avg' | 'min' | 'max' | 'count'

export interface Aggregate {
  fn: AggregateFn
  /** Coluna a agregar. Dispensada em `count`. */
  column?: string
  /** Nome da coluna no resultado (default: "fn(coluna)"). */
  as?: string
}

export interface SheetQuery {
  where?: Condition[]
  groupBy?: string[]
  aggregate?: Aggregate[]
  /** Colunas devolvidas quando NÃO há agregação (default: todas). */
  select?: string[]
  orderBy?: { column: string; direction?: 'asc' | 'desc' }
  limit?: number
}

export interface QueryResult {
  columns: string[]
  rows: CellValue[][]
  /** Linhas de dados na aba (sem o cabeçalho). */
  scanned: number
  /** Linhas de dados que passaram no `where` — SEMPRE linhas, nunca grupos:
   *  numa consulta agregada, dizer "3 após o filtro" faria o modelo relatar
   *  que 3 linhas foram consideradas, quando foram 8000 em 3 grupos. */
  matched: number
  /** Grupos formados, quando a consulta agrega. */
  groups?: number
  /** Linhas devolvidas (pode ser menor que `matched` por causa do limit). */
  returned: number
  /**
   * Células que uma agregação numérica teve que IGNORAR por não serem número
   * (texto, vazio, "n/a"). Sem isto, uma soma que pulou metade da coluna
   * chegaria ao usuário com a mesma cara de uma soma completa.
   */
  skippedCells: number
  truncated: boolean
}

export class SheetQueryError extends Error {}

const MAX_RETURNED_ROWS = 200

/**
 * Separador da chave composta de groupBy: US (unit separator, ASCII 31), o
 * caractere que existe exatamente para separar campos.
 *
 * Um separador visível — espaço, vírgula, pipe — quebraria a chave quando o
 * próprio valor contivesse um: agrupar por cidade faria "São Paulo" virar
 * dois grupos. Construído com fromCharCode para não deixar byte de controle
 * literal no fonte, que tornaria este arquivo "binário" para grep e diff.
 */
const GROUP_KEY_SEP = String.fromCharCode(31)

/** Índice da coluna pelo nome do cabeçalho (case-insensitive, sem espaços nas
 *  pontas). Erro explícito quando não existe — o modelo chuta nome de coluna,
 *  e um índice -1 silencioso viraria resultado vazio "válido". */
function columnIndex(header: string[], name: string): number {
  const wanted = name.trim().toLowerCase()
  const index = header.findIndex((h) => String(h ?? '').trim().toLowerCase() === wanted)
  if (index < 0) {
    throw new SheetQueryError(
      `Coluna não encontrada: "${name}". Colunas disponíveis: ${header.join(', ')}`,
    )
  }
  return index
}

function isEmpty(value: CellValue): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

/**
 * Número a partir de uma célula, tolerando os formatos que aparecem quando a
 * coluna foi digitada como texto: "1.234,56" (pt-BR), "1,234.56" (en), "R$
 * 1.234", "45%". Devolve null quando não dá — e o chamador CONTA esses casos
 * em vez de tratá-los como zero, porque zero mentiria na soma.
 */
export function toNumber(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  if (value === null || value === undefined) return null

  const raw = String(value).trim()
  if (raw === '') return null
  // Tira moeda, espaços e o sinal de porcentagem, preservando o sinal negativo
  let cleaned = raw.replace(/[^\d,.\-+]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null

  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    // O separador decimal é o que aparece POR ÚLTIMO; o outro é de milhar.
    cleaned =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '')
  } else if (lastComma >= 0) {
    // Só vírgula: decimal em pt-BR ("1234,5"), a menos que agrupe de 3 em 3
    // ("1,234" é mil em en) — o padrão de 3 dígitos desempata.
    cleaned = /,\d{3}(?:\D|$)/.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.')
  }

  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function text(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value).trim()
}

/** Comparação: numérica quando os dois lados são números, textual (sem
 *  diferenciar maiúscula) caso contrário. */
function matches(cell: CellValue, condition: Condition): boolean {
  if (condition.op === 'empty') return isEmpty(cell)
  if (condition.op === 'notEmpty') return !isEmpty(cell)

  const expected = condition.value ?? ''
  const cellNum = toNumber(cell)
  const expectedNum = toNumber(expected as CellValue)
  const bothNumeric = cellNum !== null && expectedNum !== null

  switch (condition.op) {
    case 'eq':
      return bothNumeric ? cellNum === expectedNum : text(cell).toLowerCase() === text(expected as CellValue).toLowerCase()
    case 'ne':
      return bothNumeric ? cellNum !== expectedNum : text(cell).toLowerCase() !== text(expected as CellValue).toLowerCase()
    case 'gt':
      return bothNumeric ? cellNum > expectedNum : text(cell) > text(expected as CellValue)
    case 'gte':
      return bothNumeric ? cellNum >= expectedNum : text(cell) >= text(expected as CellValue)
    case 'lt':
      return bothNumeric ? cellNum < expectedNum : text(cell) < text(expected as CellValue)
    case 'lte':
      return bothNumeric ? cellNum <= expectedNum : text(cell) <= text(expected as CellValue)
    case 'contains':
      return text(cell).toLowerCase().includes(text(expected as CellValue).toLowerCase())
    case 'startsWith':
      return text(cell).toLowerCase().startsWith(text(expected as CellValue).toLowerCase())
    default:
      throw new SheetQueryError(`Operador desconhecido: ${condition.op}`)
  }
}

function aggregateLabel(agg: Aggregate): string {
  return agg.as ?? (agg.fn === 'count' && !agg.column ? 'count' : `${agg.fn}(${agg.column})`)
}

/** Aplica uma agregação sobre as linhas de um grupo. Retorna o valor e quantas
 *  células foram ignoradas por não serem número. */
function applyAggregate(
  agg: Aggregate,
  rows: CellValue[][],
  header: string[],
): { value: CellValue; skipped: number } {
  if (agg.fn === 'count' && !agg.column) return { value: rows.length, skipped: 0 }

  const index = columnIndex(header, agg.column!)
  if (agg.fn === 'count') {
    return { value: rows.filter((r) => !isEmpty(r[index])).length, skipped: 0 }
  }

  const numbers: number[] = []
  let skipped = 0
  for (const row of rows) {
    const cell = row[index]
    if (isEmpty(cell)) continue // vazio não é "erro de tipo", é ausência
    const n = toNumber(cell)
    if (n === null) skipped += 1
    else numbers.push(n)
  }
  if (numbers.length === 0) return { value: null, skipped }

  switch (agg.fn) {
    case 'sum':
      return { value: numbers.reduce((a, b) => a + b, 0), skipped }
    case 'avg':
      return { value: numbers.reduce((a, b) => a + b, 0) / numbers.length, skipped }
    case 'min':
      return { value: Math.min(...numbers), skipped }
    case 'max':
      return { value: Math.max(...numbers), skipped }
    default:
      throw new SheetQueryError(`Agregação desconhecida: ${agg.fn}`)
  }
}

/**
 * Executa a consulta. `rows[0]` é o cabeçalho — é a convenção da planilha
 * usada como tabela, e a que o resto da camada de documentos já assume.
 */
export function runSheetQuery(rows: CellValue[][], query: SheetQuery): QueryResult {
  if (rows.length === 0) {
    return { columns: [], rows: [], scanned: 0, matched: 0, returned: 0, skippedCells: 0, truncated: false }
  }
  const header = rows[0].map((h) => text(h))
  const data = rows.slice(1)

  // ── filtro ────────────────────────────────────────────────────────────
  const conditions = (query.where ?? []).map((c) => ({ ...c, index: columnIndex(header, c.column) }))
  const filtered = data.filter((row) => conditions.every((c) => matches(row[c.index], c)))

  let skippedCells = 0
  let columns: string[]
  let resultRows: CellValue[][]

  if (query.aggregate && query.aggregate.length > 0) {
    const groupCols = query.groupBy ?? []
    const groupIndexes = groupCols.map((c) => columnIndex(header, c))
    const aggLabels = query.aggregate.map(aggregateLabel)
    columns = [...groupCols, ...aggLabels]

    // Sem groupBy, o conjunto inteiro é um grupo só — é o caso "some a coluna".
    const groups = new Map<string, CellValue[][]>()
    if (groupIndexes.length === 0) {
      groups.set('', filtered)
    } else {
      for (const row of filtered) {
        const key = groupIndexes.map((i) => text(row[i])).join(GROUP_KEY_SEP)
        const bucket = groups.get(key)
        if (bucket) bucket.push(row)
        else groups.set(key, [row])
      }
    }

    resultRows = []
    for (const [key, groupRows] of groups) {
      const keyValues = groupIndexes.length === 0 ? [] : key.split(GROUP_KEY_SEP)
      const values: CellValue[] = [...keyValues]
      for (const agg of query.aggregate) {
        const { value, skipped } = applyAggregate(agg, groupRows, header)
        values.push(value)
        skippedCells += skipped
      }
      resultRows.push(values)
    }
  } else {
    const selected = query.select ?? header
    const indexes = selected.map((c) => columnIndex(header, c))
    columns = selected
    resultRows = filtered.map((row) => indexes.map((i) => row[i] ?? null))
  }

  // ── ordenação ─────────────────────────────────────────────────────────
  if (query.orderBy) {
    const index = columns.findIndex(
      (c) => c.trim().toLowerCase() === query.orderBy!.column.trim().toLowerCase(),
    )
    if (index < 0) {
      throw new SheetQueryError(
        `orderBy: coluna "${query.orderBy.column}" não está no resultado. Disponíveis: ${columns.join(', ')}`,
      )
    }
    const dir = query.orderBy.direction === 'desc' ? -1 : 1
    resultRows.sort((a, b) => {
      const an = toNumber(a[index])
      const bn = toNumber(b[index])
      if (an !== null && bn !== null) return (an - bn) * dir
      return text(a[index]).localeCompare(text(b[index])) * dir
    })
  }

  const isAggregate = Boolean(query.aggregate?.length)
  const limit = Math.min(query.limit ?? MAX_RETURNED_ROWS, MAX_RETURNED_ROWS)
  const truncated = resultRows.length > limit
  const finalRows = truncated ? resultRows.slice(0, limit) : resultRows

  return {
    columns,
    rows: finalRows,
    scanned: data.length,
    matched: filtered.length,
    groups: isAggregate ? resultRows.length : undefined,
    returned: finalRows.length,
    skippedCells,
    truncated,
  }
}

/** Resultado como texto compacto para o modelo — tabela + o que foi coberto. */
export function formatQueryResult(result: QueryResult): string {
  if (result.columns.length === 0) return '(planilha vazia)'

  const cell = (v: CellValue) => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    return String(v)
  }
  const table = [result.columns.join(' | '), ...result.rows.map((r) => r.map(cell).join(' | '))].join('\n')

  // O rodapé é o que torna o número auditável: sem ele, uma soma que ignorou
  // 300 células não numéricas chega com a mesma cara de uma soma completa.
  const notes = [`${result.scanned} linhas na aba`, `${result.matched} consideradas`]
  if (result.groups !== undefined) notes.push(`${result.groups} grupo(s)`)
  if (result.truncated) notes.push(`mostrando ${result.returned} (use limit/groupBy para reduzir)`)
  if (result.skippedCells > 0) {
    notes.push(
      `${result.skippedCells} célula(s) ignorada(s) na agregação por não serem número — o total NÃO as inclui`,
    )
  }
  return `${table}\n\n[${notes.join(' · ')}]`
}
