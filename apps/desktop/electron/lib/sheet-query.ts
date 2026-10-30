/**
 * Declarative query over spreadsheet rows: filter, group, sum.
 *
 * It exists because reading the spreadsheet and adding "in your head" is expensive AND WRONG. The model
 * walking 5,000 rows spends context proportional to the file size
 * and gets the arithmetic wrong in a silent way — the answer comes out with the same
 * confident face as a correct one. Here the number is computed, not estimated.
 *
 * It is DECLARATIVE on purpose, and not "run this code": in chat mode there is no
 * sandbox, and running arbitrary code in the main process is a whole other threat
 * model. Whoever needs arbitrary code is in code mode and already has bash.
 *
 * Pure module (no Electron, no IO) to be testable — the same split as
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
  /** Not needed in `empty`/`notEmpty`. */
  value?: string | number | boolean
}

export type AggregateFn = 'sum' | 'avg' | 'min' | 'max' | 'count'

export interface Aggregate {
  fn: AggregateFn
  /** Column to aggregate. Not used in `count`. */
  column?: string
  /** Column name in the result (default: "fn(column)"). */
  as?: string
}

export interface SheetQuery {
  where?: Condition[]
  groupBy?: string[]
  aggregate?: Aggregate[]
  /** Columns returned when there is NO aggregation (default: all). */
  select?: string[]
  orderBy?: { column: string; direction?: 'asc' | 'desc' }
  limit?: number
}

export interface QueryResult {
  columns: string[]
  rows: CellValue[][]
  /** Data rows in the sheet (without the header). */
  scanned: number
  /** Data rows that passed `where` — ALWAYS rows, never groups:
   *  in an aggregated query, saying "3 after the filter" would make the model report
   *  that 3 rows were considered, when there were 8000 in 3 groups. */
  matched: number
  /** Groups formed, when the query aggregates. */
  groups?: number
  /** Rows returned (may be fewer than `matched` because of the limit). */
  returned: number
  /**
   * Cells that a numeric aggregation had to IGNORE for not being a number
   * (text, empty, "n/a"). Without this, a sum that skipped half the column
   * would reach the user with the same face as a complete sum.
   */
  skippedCells: number
  truncated: boolean
}

export class SheetQueryError extends Error {}

const MAX_RETURNED_ROWS = 200

/**
 * Separator of the groupBy composite key: US (unit separator, ASCII 31), the
 * character that exists exactly to separate fields.
 *
 * A visible separator — space, comma, pipe — would break the key when the
 * value itself contained one: grouping by city would turn "New York" into
 * two groups. Built with fromCharCode so as not to leave a literal control byte
 * in the source, which would make this file "binary" to grep and diff.
 */
const GROUP_KEY_SEP = String.fromCharCode(31)

/** Column index by header name (case-insensitive, without leading/trailing
 *  spaces). Explicit error when it does not exist — the model guesses column names,
 *  and a silent -1 index would become a "valid" empty result. */
function columnIndex(header: string[], name: string): number {
  const wanted = name.trim().toLowerCase()
  const index = header.findIndex((h) => String(h ?? '').trim().toLowerCase() === wanted)
  if (index < 0) {
    throw new SheetQueryError(
      `Column not found: "${name}". Available columns: ${header.join(', ')}`,
    )
  }
  return index
}

function isEmpty(value: CellValue): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

/**
 * Number from a cell, tolerating the formats that show up when the
 * column was typed as text: "1.234,56" (pt-BR), "1,234.56" (en), "R$
 * 1.234", "45%". It returns null when it cannot — and the caller COUNTS those cases
 * instead of treating them as zero, because zero would lie in the sum.
 */
export function toNumber(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  if (value === null || value === undefined) return null

  const raw = String(value).trim()
  if (raw === '') return null
  // Strips currency, spaces and the percentage sign, preserving the negative sign
  let cleaned = raw.replace(/[^\d,.\-+]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null

  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    // The decimal separator is the one that appears LAST; the other one is the thousands one.
    cleaned =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '')
  } else if (lastComma >= 0) {
    // Comma only: decimal in pt-BR ("1234,5"), unless it groups in threes
    // ("1,234" is a thousand in en) — the 3-digit pattern breaks the tie.
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

/** Comparison: numeric when both sides are numbers, textual (case-insensitive)
 *  otherwise. */
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
      throw new SheetQueryError(`Unknown operator: ${condition.op}`)
  }
}

function aggregateLabel(agg: Aggregate): string {
  return agg.as ?? (agg.fn === 'count' && !agg.column ? 'count' : `${agg.fn}(${agg.column})`)
}

/** Applies an aggregation over a group's rows. Returns the value and how many
 *  cells were ignored for not being numbers. */
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
    if (isEmpty(cell)) continue // empty is not a "type error", it is absence
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
      throw new SheetQueryError(`Unknown aggregation: ${agg.fn}`)
  }
}

/**
 * Runs the query. `rows[0]` is the header — it is the convention of the spreadsheet
 * used as a table, and the one the rest of the document layer already assumes.
 */
export function runSheetQuery(rows: CellValue[][], query: SheetQuery): QueryResult {
  if (rows.length === 0) {
    return { columns: [], rows: [], scanned: 0, matched: 0, returned: 0, skippedCells: 0, truncated: false }
  }
  const header = rows[0].map((h) => text(h))
  const data = rows.slice(1)

  // ── filter ────────────────────────────────────────────────────────────
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

    // Without groupBy, the whole set is a single group — it is the "sum the column" case.
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

  // ── sorting ─────────────────────────────────────────────────────────
  if (query.orderBy) {
    const index = columns.findIndex(
      (c) => c.trim().toLowerCase() === query.orderBy!.column.trim().toLowerCase(),
    )
    if (index < 0) {
      throw new SheetQueryError(
        `orderBy: column "${query.orderBy.column}" is not in the result. Available: ${columns.join(', ')}`,
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

/** Result as compact text for the model — table + what was covered. */
export function formatQueryResult(result: QueryResult): string {
  if (result.columns.length === 0) return '(empty spreadsheet)'

  const cell = (v: CellValue) => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    return String(v)
  }
  const table = [result.columns.join(' | '), ...result.rows.map((r) => r.map(cell).join(' | '))].join('\n')

  // The footer is what makes the number auditable: without it, a sum that ignored
  // 300 non-numeric cells arrives with the same face as a complete sum.
  const notes = [`${result.scanned} rows in the sheet`, `${result.matched} considered`]
  if (result.groups !== undefined) notes.push(`${result.groups} group(s)`)
  if (result.truncated) notes.push(`showing ${result.returned} (use limit/groupBy to narrow)`)
  if (result.skippedCells > 0) {
    notes.push(
      `${result.skippedCells} cell(s) skipped in the aggregation for not being numbers — the total does NOT include them`,
    )
  }
  return `${table}\n\n[${notes.join(' · ')}]`
}
