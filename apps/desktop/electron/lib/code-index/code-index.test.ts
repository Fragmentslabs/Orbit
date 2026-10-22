import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractFacts } from './extract'
import { CodeIndex, setCodeIndexCacheDir } from './store'
import { renderOutline, renderRefs, renderRepoMap, resolveSymbol, searchSymbols, signatureChanges } from './query'

const base = path.join(os.tmpdir(), `orbit-code-index-${process.pid}`)

beforeAll(() => setCodeIndexCacheDir(null))
afterAll(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

async function project(name: string, files: Record<string, string>): Promise<CodeIndex> {
  const root = path.join(base, name)
  for (const [rel, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fsp.writeFile(path.join(root, rel), content)
  }
  const index = new CodeIndex(root)
  await index.refresh()
  return index
}

describe('extractFacts', () => {
  it('acha funções, classes, métodos e variáveis de módulo em TypeScript', async () => {
    const facts = await extractFacts(
      'a.ts',
      `import { helper } from './b'
// Monta o pedido de retry.
export function buildRequest(x: number): string {
  const local = helper(x)
  return local
}
export const retry = async (n: number) => { buildRequest(n) }
class Client extends Base { send(a: string) { this.flush() } private flush() {} }
interface Options { a: string }`,
    )
    const names = facts!.defs.map((d) => `${d.kind}:${d.qual}`)
    expect(names).toEqual([
      'function:buildRequest',
      'function:retry',
      'class:Client',
      'method:Client.send',
      'method:Client.flush',
      'interface:Options',
    ])
    expect(facts!.defs[0].doc).toContain('retry')
    expect(facts!.defs[0].sig).toBe('export function buildRequest(x: number): string')
    expect(facts!.imports).toEqual(['./b'])
    // `local` é variável de função: não vira símbolo.
    expect(names.some((n) => n.includes('local'))).toBe(false)
    const uses = facts!.uses.map(([name, owner]) => `${name}@${owner}`)
    expect(uses).toContain('helper@0')
    expect(uses).toContain('buildRequest@1')
    expect(uses).toContain('flush@3')
  })

  it('qualifica método Go pelo receiver e impl do Rust pelo tipo', async () => {
    const go = await extractFacts('m.go', 'package p\ntype S struct { A int }\nfunc (s *S) M(x int) string { return helper(x) }\nfunc helper(x int) string { return "" }\n')
    expect(go!.defs.map((d) => `${d.kind}:${d.qual}`)).toEqual(['class:S', 'method:S.M', 'function:helper'])
    const rs = await extractFacts('m.rs', 'struct S { a: i32 }\nimpl Show for S { fn m(&self) -> i32 { helper(1) } }\nfn helper(x: i32) -> i32 { x }\n')
    expect(rs!.defs.map((d) => d.qual)).toEqual(['S', 'S.m', 'helper'])
  })

  it('Python: classe, método e decorator', async () => {
    const py = await extractFacts('m.py', 'class K(Base):\n    def m(self, x):\n        return foo(x)\n\n@dec\ndef foo(y):\n    pass\nLIMIT = 3\n')
    expect(py!.defs.map((d) => `${d.kind}:${d.qual}:${d.line}-${d.end}`)).toEqual([
      'class:K:1-3',
      'method:K.m:2-3',
      'function:foo:6-7',
      'variable:LIMIT:8-8',
    ])
  })

  it('extrator de linha cobre linguagem sem parser (Swift)', async () => {
    const sw = await extractFacts('V.swift', 'struct View {\n  func render() -> Int {\n    return compute()\n  }\n}\nfunc compute() -> Int { 1 }\n')
    expect(sw!.defs.map((d) => `${d.kind}:${d.qual}:${d.line}-${d.end}`)).toEqual([
      'class:View:1-5',
      'method:View.render:2-4',
      'function:compute:6-6',
    ])
    expect(sw!.uses.some(([n, owner]) => n === 'compute' && owner === 1)).toBe(true)
  })

  it('ignora extensão desconhecida', async () => {
    expect(await extractFacts('notes.txt', 'hello')).toBeNull()
  })
})

describe('CodeIndex', () => {
  it('liga usos a definições, preferindo o arquivo importado', async () => {
    const index = await project('graph', {
      'src/upload.ts': "import { retryWithBackoff } from './net/retry'\nexport function uploadFile(p: string) {\n  return retryWithBackoff(() => p)\n}\n",
      'src/net/retry.ts': '/** Exponential backoff for flaky requests. */\nexport function retryWithBackoff<T>(fn: () => T): T {\n  return fn()\n}\n',
      'src/other/retry.ts': 'export function retryWithBackoff() {}\n',
      'src/cli.ts': "import { uploadFile } from './upload'\nuploadFile('x')\n",
    })
    const keys = resolveSymbol(index, 'retryWithBackoff', 'src/net')
    expect(keys).toHaveLength(1)
    const refs = renderRefs(index, keys, { direction: 'in', depth: 1 })
    expect(refs).toContain('uploadFile — src/upload.ts:3')
    expect(renderRefs(index, resolveSymbol(index, 'retryWithBackoff', 'src/other'), { direction: 'in', depth: 1 })).toBe(
      'No uses found in the index.',
    )

    const blast = renderRefs(index, keys, { direction: 'in', depth: 3 })
    expect(blast).toContain('src/upload.ts: uploadFile')
    expect(blast).toContain('src/cli.ts: (top level)°2')
  })

  it('nome de pacote ou local não é ligado a homônimo de outro arquivo', async () => {
    const index = await project('shadow', {
      'config.js': "const path = require('path')\nmodule.exports = path\n",
      'a.ts': "import path from 'node:path'\nexport function join(value: string) { return path.join(value) }\n",
      'b.ts': 'export const value = 1\n',
      'c.ts': "import { join } from '@app/a'\nexport function run() { return join('x') }\n",
    })
    const graph = index.getGraph()
    // O `path` de config.js só é usado no próprio arquivo; o de a.ts é o pacote.
    expect((graph.incoming.get('config.js#0') ?? []).map((e) => e.from)).toEqual(['config.js#-1'])
    expect(graph.incoming.get('b.ts#0')).toBeUndefined()
    // Alias `@app/a` resolve para a.ts pelo resto do caminho.
    expect(renderRefs(index, resolveSymbol(index, 'join'), { direction: 'in', depth: 1 })).toContain('run — c.ts:2')
  })

  it('busca por intenção acha pelo comentário e pelo nome', async () => {
    const index = await project('search', {
      'src/net/retry.ts': '/** Exponential backoff for flaky requests. */\nexport function retryWithBackoff() {}\n',
      'src/ui/button.ts': 'export function renderButton() {}\n',
    })
    expect(searchSymbols(index, 'backoff flaky requests')[0].doc.def.name).toBe('retryWithBackoff')
    expect(searchSymbols(index, 'renderButton')[0].doc.def.name).toBe('renderButton')
    expect(searchSymbols(index, 'button', { scope: 'src/net' })).toHaveLength(0)
  })

  it('outline e mapa do projeto', async () => {
    const index = await project('outline', {
      'lib/a.ts': "import { helperB } from './b'\nexport class A {\n  run() { helperB() }\n}\n",
      'lib/b.ts': 'export function helperB() {}\n',
    })
    const outline = renderOutline(index, 'lib/a.ts')!
    expect(outline).toContain('L2-4 class export class A')
    expect(outline).toContain('  L3-3 method run()')
    expect(renderRepoMap(index)).toContain('helperB')
  })

  it('re-extrai só o que mudou e avisa assinatura alterada com usos fora', async () => {
    const index = await project('edit', {
      'a.ts': 'export function target(x: number) {}\n',
      'b.ts': "import { target } from './a'\nexport function caller() { target(1) }\n",
    })
    const before = index.files.get('a.ts')!.defs
    const graph = index.getGraph()
    await fsp.writeFile(path.join(index.root, 'a.ts'), 'export function target(x: number, y: number) {}\n')
    await index.touch('a.ts')
    expect(signatureChanges(index, graph, 'a.ts', before)).toContain('target (signature changed) is used in b.ts:2')

    // Mudar só o corpo não gera aviso.
    const graph2 = index.getGraph()
    const before2 = index.files.get('a.ts')!.defs
    await fsp.writeFile(path.join(index.root, 'a.ts'), 'export function target(x: number, y: number) { return x }\n')
    await index.touch('a.ts')
    expect(signatureChanges(index, graph2, 'a.ts', before2)).toBe('')
  })
})
