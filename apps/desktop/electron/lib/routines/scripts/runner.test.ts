import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { runScript } from './runner'

const base = { hosts: [] as string[], readFiles: false }
const fakeFetch = (async (url: URL) => new Response(JSON.stringify({ price: 2380, url: String(url) }), { status: 200 })) as unknown as typeof fetch

describe('runScript', () => {
  it('returns the value, keeps state, dedupes with seen and collects fires', async () => {
    const code = `
      state.set('n', (state.get('n') ?? 0) + 1)
      if (!seen('a')) fire({ id: 'a' })
      log('hello', { x: 1 })
      return 42`
    const first = await runScript({ script: { ...base, code }, folders: [] })
    expect(first.ok && first.result).toBe(42)
    if (!first.ok) throw new Error('unreachable')
    expect(first.fires).toEqual(['{"id":"a"}'])
    expect(first.logs).toEqual(['hello {"x":1}'])
    const second = await runScript({ script: { ...base, code }, folders: [], state: first.state })
    if (!second.ok) throw new Error('unreachable')
    expect(second.fires).toEqual([])
    expect(second.state.kv.n).toBe(2)
  })

  it('reports an error the script throws', async () => {
    const out = await runScript({ script: { ...base, code: 'throw new Error("boom")' }, folders: [] })
    expect(out).toMatchObject({ ok: false, error: 'boom' })
  })

  it('stops a script that never ends', async () => {
    const out = await runScript({ script: { ...base, code: 'while (true) {}' }, folders: [] })
    expect(out.ok).toBe(false)
  }, 15_000)

  it('has no way to reach the host process', async () => {
    const code = `
      const tries = []
      try { tries.push(typeof process) } catch (e) { tries.push('x') }
      try { tries.push(typeof require) } catch (e) { tries.push('x') }
      try { this.constructor.constructor('return process')(); tries.push('escaped') } catch (e) { tries.push('blocked') }
      return tries`
    const out = await runScript({ script: { ...base, code }, folders: [] })
    expect(out.ok && out.result).toEqual(['undefined', 'undefined', 'blocked'])
  })

  it('fetches only declared hosts', async () => {
    const code = `const r = await fetch('https://api.shop.com/p'); return (await r.json()).price`
    const allowed = await runScript({ script: { code, hosts: ['shop.com'] }, folders: [], fetchImpl: fakeFetch })
    expect(allowed.ok && allowed.result).toBe(2380)
    const denied = await runScript({ script: { code, hosts: ['other.com'] }, folders: [], fetchImpl: fakeFetch })
    expect(denied.ok).toBe(false)
  })

  it('reads files and spreadsheets only inside the folders, and only when declared', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-script-'))
    const sheet = XLSX.utils.aoa_to_sheet([['name', 'total'], ['A', 3]])
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, 'Report')
    fs.writeFileSync(path.join(dir, 'report.xlsx'), XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    const code = `return (await readSheet('report.xlsx')).rows`
    const ok = await runScript({ script: { code, hosts: [], readFiles: true }, folders: [dir] })
    expect(ok.ok && ok.result).toEqual([{ name: 'A', total: 3 }])
    const undeclared = await runScript({ script: { code, hosts: [], readFiles: false }, folders: [dir] })
    expect(undeclared.ok).toBe(false)
    const outside = await runScript({ script: { code: `return await readFile('/etc/hosts')`, hosts: [], readFiles: true }, folders: [dir] })
    expect(outside.ok).toBe(false)
  })

  it('queries a declared SQLite file through db.query, read-only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-run-db-'))
    try {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
      const db = new DatabaseSync(path.join(dir, 'r.sqlite'))
      db.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2), (3)")
      db.close()
      const run = (code: string, databases?: string[]) => runScript({ script: { ...base, code, databases }, folders: [dir] })
      const ok = await run("const r = await db.query('r.sqlite', 'SELECT SUM(n) AS s FROM t WHERE n > ?', [1]); return r.rows[0].s", ['r.sqlite'])
      expect(ok.ok && ok.result).toBe(5)
      const write = await run("await db.query('r.sqlite', 'DELETE FROM t')", ['r.sqlite'])
      expect(write.ok).toBe(false)
      const undeclared = await run("await db.query('r.sqlite', 'SELECT 1')")
      expect(!undeclared.ok && undeclared.error).toMatch(/did not declare/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
