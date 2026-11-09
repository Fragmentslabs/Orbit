import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DB_MAX_ROWS, queryDatabase } from './sqlite'

// Vite does not know the `node:sqlite` built-in, so it is loaded the way Node does.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

let root: string
let outside: string
let folders: string[]

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-out-'))
  const make = (file: string) => {
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE sales (id INTEGER PRIMARY KEY, region TEXT, total REAL, big INTEGER, raw BLOB)')
    const insert = db.prepare('INSERT INTO sales (region, total, big, raw) VALUES (?, ?, ?, ?)')
    db.exec('BEGIN')
    for (let i = 0; i < DB_MAX_ROWS + 10; i++) insert.run(i % 2 ? 'north' : 'south', i, 9007199254740993n, new Uint8Array([1, 2, 3]))
    db.exec('COMMIT')
    db.close()
  }
  fs.mkdirSync(path.join(root, 'data'))
  make(path.join(root, 'data', 'sales.sqlite'))
  make(path.join(root, 'other.db'))
  make(path.join(outside, 'secret.db'))
  fs.symlinkSync(path.join(outside, 'secret.db'), path.join(root, 'link.db'))
  folders = [root]
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

const run = (sql: unknown, extra: { requested?: string; declared?: string[]; params?: unknown; timeoutMs?: number } = {}) =>
  queryDatabase({
    requested: extra.requested ?? 'data/sales.sqlite',
    declared: extra.declared ?? ['data/sales.sqlite'],
    folders,
    sql,
    params: extra.params,
    timeoutMs: extra.timeoutMs,
  })

describe('queryDatabase', () => {
  it('returns columns and rows, binding parameters', async () => {
    const result = await run('SELECT region, total FROM sales WHERE id = ?', { params: [3] })
    expect(result.columns).toEqual(['region', 'total'])
    expect(result.rows).toEqual([{ region: 'south', total: 2 }])
    expect(result.truncated).toBe(false)
  })

  it('turns blobs and huge integers into JSON-safe values', async () => {
    const result = await run('SELECT raw, big FROM sales LIMIT 1')
    expect(result.rows[0]).toEqual({ raw: '<blob 3 bytes>', big: '9007199254740993' })
  })

  it('caps the rows and says so', async () => {
    const result = await run('SELECT * FROM sales')
    expect(result.rows).toHaveLength(DB_MAX_ROWS)
    expect(result.truncated).toBe(true)
  })

  it('allows WITH queries and schema reads', async () => {
    expect((await run('WITH x AS (SELECT 1 AS n) SELECT n FROM x')).rows).toEqual([{ n: 1 }])
    expect((await run("SELECT name FROM sqlite_master WHERE type = 'table'")).rows).toEqual([{ name: 'sales' }])
  })

  it.each([
    ['INSERT', "INSERT INTO sales (region) VALUES ('x')"],
    ['UPDATE', "UPDATE sales SET region = 'x'"],
    ['DELETE', 'DELETE FROM sales'],
    ['DROP', 'DROP TABLE sales'],
    ['CREATE', 'CREATE TABLE t (a)'],
    ['PRAGMA write', 'PRAGMA user_version = 7'],
    ['PRAGMA read', 'PRAGMA table_info(sales)'],
    ['ATTACH', "ATTACH DATABASE '/tmp/other.db' AS other"],
    ['transaction', 'BEGIN'],
    ['extension', "SELECT load_extension('x')"],
  ])('refuses %s', async (_name, sql) => {
    await expect(run(sql)).rejects.toThrow()
  })

  it('leaves the data untouched after refused writes', async () => {
    await expect(run('DELETE FROM sales')).rejects.toThrow()
    expect((await run('SELECT COUNT(*) AS n FROM sales')).rows).toEqual([{ n: DB_MAX_ROWS + 10 }])
  })

  it('reports bad SQL and missing input as errors', async () => {
    await expect(run('SELEC nope')).rejects.toThrow(/syntax/i)
    await expect(run('SELECT * FROM missing_table')).rejects.toThrow(/no such table/i)
    await expect(run('')).rejects.toThrow(/Provide the SQL/)
    await expect(run(42)).rejects.toThrow(/Provide the SQL/)
    await expect(run('SELECT 1', { params: [{ a: 1 }] })).rejects.toThrow(/Parameters/)
    await expect(run('x'.repeat(20_000))).rejects.toThrow(/longer than/)
  })

  it('stops a runaway query', async () => {
    const started = Date.now()
    await expect(
      run('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT COUNT(*) FROM r', { timeoutMs: 300 }),
    ).rejects.toThrow(/too long/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  describe('which files', () => {
    it('only opens declared databases', async () => {
      await expect(run('SELECT 1', { requested: 'other.db' })).rejects.toThrow(/did not declare the database/)
      await expect(run('SELECT 1', { declared: [] })).rejects.toThrow(/did not declare any database/)
    })

    it('treats different spellings of a declared path as the same file', async () => {
      expect((await run('SELECT 1 AS n', { requested: './data/../data/sales.sqlite' })).rows).toEqual([{ n: 1 }])
    })

    it('refuses paths outside the routine folders, even when declared', async () => {
      const secret = path.join(outside, 'secret.db')
      await expect(run('SELECT 1', { requested: secret, declared: [secret] })).rejects.toThrow(/only read inside/)
      await expect(run('SELECT 1', { requested: '../x.db', declared: ['../x.db'] })).rejects.toThrow()
    })

    it('refuses a symlink that leaves the folder', async () => {
      await expect(run('SELECT 1', { requested: 'link.db', declared: ['link.db'] })).rejects.toThrow(/only read inside/)
    })

    it('reports a missing file', async () => {
      await expect(run('SELECT 1', { requested: 'nope.db', declared: ['nope.db'] })).rejects.toThrow(/Not found/)
    })
  })
})
