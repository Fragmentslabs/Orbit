import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { coerceProp, isSafeRelativePath, type PropsSchema } from './motion-props'

/**
 * Videos in bulk: where the variations come from and how they are made ready.
 *
 *  - a TABLE (CSV or JSON, one row per video): the header is the prop name, the cell is its value, an
 *    empty cell keeps the default. A column called `file` (or `_name`, `label`, `slug`) names the output
 *    file. Excel in pt-BR saves with `;` and a decimal comma: both are understood.
 *  - IMAGES per variation: a prop of type image may point to a file of the project or an attachment; it is
 *    copied into the piece (props-assets/) so the page can load it by a relative path.
 *  - the ETA of a long batch.
 *
 * Nothing here knows about Electron: the table parsing is pure, the staging takes the "where is this
 * file" lookup as a function.
 */

// ---------------------------------------------------------------------------------------------- table

/** Splits CSV text into rows of cells (RFC 4180: quotes, doubled quotes, newlines inside quotes). Pure. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const d = delimiter ?? detectDelimiter(src)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i += 1
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === d) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(cell)
      cell = ''
      rows.push(row)
      row = []
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** The delimiter of the header line: the one of , ; tab that appears most OUTSIDE quotes. */
export function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? ''
  const count: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch in count) count[ch] += 1
  }
  const best = (Object.entries(count) as Array<[string, number]>).sort((a, b) => b[1] - a[1])[0]
  return best[1] > 0 ? best[0] : ','
}

export interface Table {
  headers: string[]
  rows: Array<Record<string, string>>
}

/** CSV text, or JSON (an array of objects, or { rows: [...] }), as a table of strings. Throws with the reason. */
export function parseTable(text: string): Table {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('the table is empty')
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch (err) {
      throw new Error(`the table looks like JSON but does not parse: ${(err as Error).message}`)
    }
    const list = Array.isArray(raw) ? raw : (raw as { rows?: unknown })?.rows
    if (!Array.isArray(list) || !list.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      throw new Error('JSON must be an array of objects (one per video), or { "rows": [ … ] }')
    }
    const headers: string[] = []
    const rows = (list as Array<Record<string, unknown>>).map((r) => {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(r)) {
        if (!headers.includes(k)) headers.push(k)
        out[k] = v === null || v === undefined ? '' : String(v)
      }
      return out
    })
    return { headers, rows }
  }
  const cells = parseCsv(text)
  if (cells.length < 2) throw new Error('a CSV needs a header line (the prop names) and at least one row')
  const headers = cells[0].map((h) => h.trim())
  if (headers.some((h) => !h)) throw new Error('every column of the header needs a name')
  if (new Set(headers).size !== headers.length) throw new Error(`the header repeats a column: ${headers.filter((h, i) => headers.indexOf(h) !== i)[0]}`)
  const rows = cells.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])))
  return { headers, rows }
}

/** Columns that name the output file when they are not props themselves. */
const LABEL_COLUMNS = ['_name', 'file', 'filename', 'label', 'slug']

export interface FromTable {
  variations: Array<{ name: string; props: Record<string, unknown> }>
  errors: string[]
  /** The column that named the files, when there is one. */
  labelColumn?: string
}

/**
 * One variation per row. A column is a prop when its header is declared in props.json; the label column
 * names the file; any other column is an ERROR (a typo in a header must not become fifty default videos).
 * A number with a decimal comma ("12,5") is understood; an empty cell keeps the default.
 */
export function variationsFromTable(schema: PropsSchema, table: Table): FromTable {
  const errors: string[] = []
  const declared = Object.keys(schema)
  const labelColumn = LABEL_COLUMNS.find((c) => table.headers.includes(c) && !(c in schema))
  const unknown = table.headers.filter((h) => !(h in schema) && h !== labelColumn)
  if (unknown.length) {
    errors.push(`column${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `"${u}"`).join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not declared in props.json — declared: ${declared.join(', ') || 'none'}; to name the files use a column called file`)
  }
  const used = table.headers.filter((h) => h in schema)
  if (!used.length && !unknown.length) errors.push('no column matches a declared prop')
  const variations = table.rows.map((row, index) => {
    const props: Record<string, unknown> = {}
    for (const column of used) {
      let cell = row[column] ?? ''
      if (cell === '') continue
      if (schema[column].type === 'number' && /^-?\d+,\d+$/.test(cell)) cell = cell.replace(',', '.')
      props[column] = cell
    }
    const label = labelColumn ? row[labelColumn] : undefined
    // The first cell is a fair name when nothing else names the row.
    const fallback = table.headers.length ? row[table.headers.find((h) => h !== labelColumn) ?? table.headers[0]] : ''
    return { name: label || fallback || String(index + 1), props }
  })
  // Check every cell against its type NOW, with the row and column, instead of one by one in the batch.
  table.rows.forEach((_, i) => {
    for (const [name, value] of Object.entries(variations[i].props)) {
      const checked = coerceProp(schema[name], value, name)
      if (!checked.ok) errors.push(`row ${i + 2} ("${variations[i].name}"): ${checked.error}`)
    }
  })
  return { variations, errors, labelColumn }
}

// --------------------------------------------------------------------------------------------- images

export const PROPS_ASSETS_DIR = 'props-assets'

/** A name that cannot escape the folder and tells what the file is. */
function safeBase(file: string): string {
  const base = path.basename(file).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '')
  return base || 'image'
}

async function hashFile(file: string): Promise<string> {
  return createHash('sha1').update(await fsp.readFile(file)).digest('hex').slice(0, 10)
}

export interface StageResult {
  props: Record<string, unknown>
  errors: string[]
}

/**
 * The image props of one variation, made loadable: a value that is already a file of the piece stays; a
 * file of the project or an attachment (`find` says where) is copied into props-assets/ under a name made
 * of its content hash — the same photo is copied once — and the value becomes that relative path. An image
 * that is nowhere is an error with the prop name, not a broken frame in the middle of a batch.
 */
export async function stageImageProps(opts: {
  folder: string
  schema: PropsSchema
  props: Record<string, unknown>
  find: (value: string) => Promise<string | null>
}): Promise<StageResult> {
  const out: Record<string, unknown> = { ...opts.props }
  const errors: string[] = []
  for (const [name, value] of Object.entries(opts.props)) {
    if (opts.schema[name]?.type !== 'image' || typeof value !== 'string') continue
    const inside = isSafeRelativePath(value) ? path.resolve(opts.folder, value) : null
    if (inside && inside.startsWith(path.resolve(opts.folder) + path.sep) && (await fsp.stat(inside).catch(() => null))?.isFile()) continue
    const source = await opts.find(value)
    if (!source || !(await fsp.stat(source).catch(() => null))?.isFile()) {
      errors.push(`${name}: the image "${value}" was not found — not in the piece, in the project, nor among the attachments`)
      continue
    }
    const relative = `${PROPS_ASSETS_DIR}/${await hashFile(source)}-${safeBase(source)}`
    const target = path.join(opts.folder, relative)
    if (!(await fsp.stat(target).catch(() => null))) {
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.copyFile(source, target)
    }
    out[name] = relative
  }
  return { props: out, errors }
}

// ------------------------------------------------------------------------------------------------ ETA

/** "45 s", "3 min 20 s", "1 h 05 min" — rounded, for a progress line. Pure. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s ? `${m} min ${String(s).padStart(2, '0')} s` : `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** Time left, from the average of what is done. `null` until there is something to average. Pure. */
export function estimateRemainingMs(doneDurationsMs: number[], remaining: number): number | null {
  if (!doneDurationsMs.length || remaining <= 0) return remaining <= 0 ? 0 : null
  const avg = doneDurationsMs.reduce((a, b) => a + b, 0) / doneDurationsMs.length
  return avg * remaining
}

/** What the progress line says: the number being rendered, the total and the time left (null until known). Pure. */
export function batchProgress(done: number, total: number, doneDurationsMs: number[]): { n: number; total: number; left: string | null } {
  const left = done > 0 ? estimateRemainingMs(doneDurationsMs, total - done) : null
  return { n: done + 1, total, left: left === null ? null : formatDuration(left) }
}

