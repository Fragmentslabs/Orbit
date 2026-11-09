import { Worker } from 'node:worker_threads'
import { resolveInsideFolders } from './guards'

/**
 * Read-only access of a script to SQLite files inside the routine folders (`db.query`).
 *
 * The file must be one the script DECLARED (and the person approved). Read-only is enforced in
 * layers, none of which trusts the SQL: the file is opened with the read-only flag; an authorizer
 * refuses everything but SELECT-like actions (so no ATTACH, PRAGMA, DDL, DML or transactions);
 * rows and bytes are capped; and the query runs in its own worker thread that is terminated when
 * it takes too long, so a runaway query (a recursive CTE, a huge join) cannot freeze the app.
 */

export const DB_QUERY_TIMEOUT_MS = 5_000
export const DB_MAX_ROWS = 5_000
export const DB_MAX_RESULT_CHARS = 2_000_000
export const DB_MAX_SQL_CHARS = 10_000
export const DB_MAX_PARAMS = 100

export type DbParam = string | number | null
export interface DbResult {
  columns: string[]
  rows: Record<string, unknown>[]
  truncated: boolean
}

/** Runs inside the query worker: opens read-only, installs the authorizer, reads at most the caps. */
const DB_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync, constants } = require('node:sqlite');
const allowed = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: true });
  db.setAuthorizer((action) => (allowed.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY));
  const statement = db.prepare(workerData.sql);
  statement.setReadBigInts(true);
  const columns = statement.columns().map((c) => c.name);
  const rows = [];
  let chars = 0;
  let truncated = false;
  for (const row of statement.iterate(...workerData.params)) {
    const out = {};
    for (const key of Object.keys(row)) {
      const v = row[key];
      out[key] =
        typeof v === 'bigint' ? (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString())
        : v instanceof Uint8Array ? '<blob ' + v.byteLength + ' bytes>'
        : v;
    }
    chars += JSON.stringify(out).length;
    if (rows.length >= workerData.maxRows || chars > workerData.maxChars) { truncated = true; break; }
    rows.push(out);
  }
  parentPort.postMessage({ ok: true, result: { columns, rows, truncated } });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
} finally {
  try { if (db) db.close(); } catch {}
}
`

/** Is every declared parameter something SQLite can bind without surprises? */
function cleanParams(raw: unknown): DbParam[] | string {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > DB_MAX_PARAMS) return `Parameters must be a list of at most ${DB_MAX_PARAMS} values.`
  const out: DbParam[] = []
  for (const value of raw) {
    if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) out.push(value)
    else if (typeof value === 'boolean') out.push(value ? 1 : 0)
    else return 'Parameters can only be text, numbers, booleans or null.'
  }
  return out
}

/**
 * Resolves the requested database to a real file and checks it is one of the declared ones.
 * Both sides go through the folder containment check, so `./a.db`, `a.db` and a symlink to it
 * are the same file, and a path outside the routine folders never matches.
 */
export function resolveDeclaredDatabase(requested: string, declared: readonly string[], folders: readonly string[]): { ok: true; path: string } | { ok: false; error: string } {
  if (declared.length === 0) return { ok: false, error: 'The script did not declare any database.' }
  const target = resolveInsideFolders(requested, folders)
  if (!target.ok) return target
  for (const entry of declared) {
    const resolved = resolveInsideFolders(entry, folders)
    if (resolved.ok && resolved.path === target.path) return target
  }
  return { ok: false, error: `The script did not declare the database ${requested.slice(0, 120)}.` }
}

/** Runs one read-only query on a declared SQLite file. Rejects with a readable message. */
export async function queryDatabase(options: {
  requested: string
  sql: unknown
  params?: unknown
  declared: readonly string[]
  folders: readonly string[]
  timeoutMs?: number
}): Promise<DbResult> {
  const file = resolveDeclaredDatabase(options.requested, options.declared, options.folders)
  if (!file.ok) throw new Error(file.error)
  if (typeof options.sql !== 'string' || options.sql.trim() === '') throw new Error('Provide the SQL to run.')
  if (options.sql.length > DB_MAX_SQL_CHARS) throw new Error(`The SQL is longer than ${DB_MAX_SQL_CHARS} characters.`)
  const params = cleanParams(options.params)
  if (typeof params === 'string') throw new Error(params)

  return new Promise<DbResult>((resolve, reject) => {
    const worker = new Worker(DB_WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 128 },
      workerData: { file: file.path, sql: options.sql, params, maxRows: DB_MAX_ROWS, maxChars: DB_MAX_RESULT_CHARS },
    })
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      settle()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('The query took too long and was stopped.'))),
      options.timeoutMs ?? DB_QUERY_TIMEOUT_MS,
    )
    worker.on('message', (m: { ok: true; result: DbResult } | { ok: false; error: string }) =>
      finish(() => (m.ok ? resolve(m.result) : reject(new Error(m.error)))),
    )
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', () => finish(() => reject(new Error('The database query stopped unexpectedly.'))))
  })
}
