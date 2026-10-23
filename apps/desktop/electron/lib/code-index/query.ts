import fs from 'node:fs/promises'
import path from 'node:path'
import type { SymbolDef } from './extract'
import { parseKey, symbolKey, type CodeGraph, type CodeIndex, type Edge, type SymbolKey } from './store'

/**
 * As consultas que viram tools. Todas devolvem texto compacto e com
 * `arquivo:linha` exato — o objetivo é o agente chegar ao trecho certo sem
 * a rodada de grep → read → read que ele faria sozinho.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'per', 'are', 'is', 'was', 'be', 'by', 'to', 'of', 'in', 'on', 'at', 'an', 'it', 'its', 'all', 'with', 'from', 'that', 'this', 'how', 'where', 'what', 'which', 'when', 'does', 'into',
  'code', 'file', 'function', 'logic', 'handle', 'handles', 'handling', 'implementation', 'implement',
  'de', 'da', 'do', 'das', 'dos', 'que', 'com', 'para', 'por', 'uma', 'um', 'onde', 'como', 'qual', 'quando',
  'no', 'na', 'nos', 'nas', 'em', 'ao', 'os', 'as', 'se', 'eh', 'é', 'função', 'funcao', 'arquivo', 'codigo', 'código',
])

/** `buildToolSet` → build, tool, set; `MAX_FILE_BYTES` → max, file, bytes. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .map(stem)
}

/** Plural simples (tools → tool, entries → entry): o suficiente para nome de código. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

/** Teste e mock respondem à mesma busca que o código real, mas raramente são o que se procura. */
export const isTestFile = (file: string) => /(^|\/)(__tests__|tests?|__mocks__)\/|\.(test|spec)\.[^.]+$/.test(file)

interface SearchDoc {
  key: SymbolKey
  def: SymbolDef
  file: string
  name: Set<string>
  where: Set<string>
  about: Set<string>
  /** Nomes que a definição usa no corpo (`model.limit.context` → limit, context). */
  body: Set<string>
}

/** Os documentos de busca vivem junto do grafo: ambos mudam só quando o índice muda. */
const docsCache = new WeakMap<CodeGraph, SearchDoc[]>()

function searchDocs(index: CodeIndex, graph: CodeGraph): SearchDoc[] {
  let docs = docsCache.get(graph)
  if (docs) return docs
  docs = []
  for (const [file, entry] of index.files) {
    const where = new Set(tokenize(file.replace(/\.[^.]+$/, '')))
    const usedBy = new Map<number, Set<string>>()
    for (const [name, owner] of entry.uses) {
      if (owner < 0) continue
      let set = usedBy.get(owner)
      if (!set) usedBy.set(owner, (set = new Set()))
      for (const token of tokenize(name)) set.add(token)
    }
    entry.defs.forEach((def, i) => {
      docs!.push({
        key: symbolKey(file, i),
        def,
        file,
        name: new Set(tokenize(def.qual)),
        where,
        about: new Set(tokenize(`${def.sig} ${def.doc}`)),
        body: usedBy.get(i) ?? new Set(),
      })
    })
  }
  docsCache.set(graph, docs)
  return docs
}

/** Casa termo e token; prefixo comum (≥4) vale parcial — `index` acha `indexer`, `pars` acha `parse`. */
function overlap(term: string, tokens: Set<string>): number {
  if (tokens.has(term)) return 1
  if (term.length < 4) return 0
  for (const token of tokens) {
    if (token.length >= 4 && (token.startsWith(term) || term.startsWith(token))) return 0.6
  }
  return 0
}

const KIND_WEIGHT: Record<string, number> = { variable: 0.75, module: 0.8 }
/**
 * O corpo pesa pouco e conta meio termo na cobertura: liga "limite de
 * contexto" a quem lê `model.limit.context`, sem deixar uma função de 1.000
 * linhas (que usa de tudo) casar com qualquer busca.
 */
const BODY_WEIGHT = 0.5

export interface SearchHit {
  doc: SearchDoc
  score: number
}

export function searchSymbols(index: CodeIndex, query: string, opts: { limit?: number; scope?: string } = {}): SearchHit[] {
  const graph = index.getGraph()
  const terms = [...new Set(tokenize(query).filter((t) => !STOPWORDS.has(t)))]
  if (terms.length === 0) return []
  const docs = searchDocs(index, graph).filter((d) => !opts.scope || inScope(d.file, opts.scope))
  // IDF: um termo que aparece em todo símbolo (ex.: o nome do projeto) não discrimina nada.
  const df = terms.map((t) =>
    docs.reduce((n, d) => n + (overlap(t, d.name) || overlap(t, d.where) || overlap(t, d.about) || overlap(t, d.body) ? 1 : 0), 0),
  )
  const idf = df.map((n) => Math.log(1 + docs.length / (1 + n)))
  const compact = terms.join('')

  const hits: SearchHit[] = []
  for (const doc of docs) {
    let score = 0
    let matched = 0
    terms.forEach((term, i) => {
      const direct = 3 * overlap(term, doc.name) + 1.5 * overlap(term, doc.where) + overlap(term, doc.about)
      const s = direct > 0 ? direct : BODY_WEIGHT * overlap(term, doc.body)
      if (s > 0) {
        matched += direct > 0 ? 1 : 0.5
        score += idf[i] * s
      }
    })
    if (matched === 0) continue
    const lowerName = doc.def.name.toLowerCase()
    if (lowerName === compact) score += 8
    else if (compact.length >= 4 && lowerName.includes(compact)) score += 3
    score *= (matched / terms.length) ** 1.5
    score *= 1 + 0.15 * Math.log2(1 + (graph.inDegree.get(doc.key) ?? 0))
    score *= KIND_WEIGHT[doc.def.kind] ?? 1
    if (isTestFile(doc.file)) score *= 0.5
    hits.push({ doc, score })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, opts.limit ?? 6)
}

/** Prefixo de pasta por segmento: `src/a` cobre `src/a/x.ts`, não `src/ab.ts`. */
function inScope(file: string, scope: string): boolean {
  const clean = scope.replace(/^\.\/?/, '').replace(/\/+$/, '')
  return !clean || file === clean || file.startsWith(`${clean}/`)
}

const numbered = (lines: string[], from: number) =>
  lines.map((l, i) => `${String(from + i).padStart(5)}| ${l.slice(0, 400)}`).join('\n')

async function readLines(index: CodeIndex, file: string): Promise<string[] | null> {
  try {
    return (await fs.readFile(path.join(index.root, file), 'utf8')).split('\n')
  } catch {
    return null
  }
}

function describe(def: SymbolDef): string {
  return `${def.kind} ${def.qual}`
}

/**
 * Até 3 quem-usa, com a linha da CHAMADA (não a da definição de quem chama):
 * é a linha que o agente vai abrir.
 */
function usersLine(graph: CodeGraph, key: SymbolKey, index: CodeIndex): string {
  const firstCall = new Map<SymbolKey, number>()
  for (const edge of graph.incoming.get(key) ?? []) {
    const known = firstCall.get(edge.from)
    if (known === undefined || edge.line < known) firstCall.set(edge.from, edge.line)
  }
  if (firstCall.size === 0) return ''
  // "quem → arquivo:linha da chamada": o formato diz sozinho que a linha é a
  // do uso — no benchmark o agente leu "(arquivo:linha)" como a definição de
  // quem chama e foi atrás do call site com grep.
  const shown = [...firstCall].slice(0, 3).map(([from, line]) => `${nameOf(index, from)} → ${parseKey(from).file}:${line}`)
  const more = firstCall.size > 3 ? ` +${firstCall.size - 3}` : ''
  return `called at: ${shown.join(', ')}${more}`
}

function nameOf(index: CodeIndex, key: SymbolKey): string {
  const { file, def } = parseKey(key)
  return def < 0 ? '(top level)' : index.files.get(file)?.defs[def]?.qual ?? '?'
}

/** `137, 293, 306 +8`: as linhas de um quem-usa, compactas. */
function lineList(lines: number[], max = 6): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  return sorted.slice(0, max).join(', ') + (sorted.length > max ? ` +${sorted.length - max}` : '')
}

function labelFor(index: CodeIndex, key: SymbolKey): string {
  const { file, def } = parseKey(key)
  const entry = index.files.get(file)
  if (def < 0 || !entry?.defs[def]) return `${file} (top level)`
  const d = entry.defs[def]
  return `${d.qual} (${file}:${d.line})`
}

/** Resultados que vêm com código; os demais só com cabeçalho e assinatura. */
const EXCERPT_HITS = 3
const EXCERPT_LINES = 8

/**
 * Os primeiros resultados trazem o começo do código; o resto, só onde está e
 * a assinatura. Código de resultado que o agente não vai usar é contexto
 * pago em todos os passos seguintes do turno.
 */
export async function renderSearch(index: CodeIndex, hits: SearchHit[], opts: { full?: boolean } = {}): Promise<string> {
  const graph = index.getGraph()
  const blocks: string[] = []
  for (const [rank, { doc }] of hits.entries()) {
    const { def, file } = doc
    const users = usersLine(graph, doc.key, index)
    const head = `## ${file}:${def.line}-${def.end} · ${describe(def)}${users ? `\n${users}` : ''}`
    if (!opts.full && rank >= EXCERPT_HITS) {
      blocks.push(`${head}\n  ${def.sig || def.name}`)
      continue
    }
    const lines = await readLines(index, file)
    if (!lines) continue
    const span = def.end - def.line + 1
    const max = opts.full ? 200 : EXCERPT_LINES
    const shown = lines.slice(def.line - 1, def.line - 1 + Math.min(span, max))
    const rest = span > max ? `\n      … +${span - max} lines (read ${file} offset ${def.line + max})` : ''
    blocks.push(`${head}\n${numbered(shown, def.line)}${rest}`)
  }
  return blocks.join('\n\n')
}

/** Assinaturas de um arquivo com o intervalo de linhas — o arquivo sem os corpos. */
export function renderOutline(index: CodeIndex, file: string): string | null {
  const entry = index.files.get(file)
  if (!entry) return null
  const graph = index.getGraph()
  const depth = (i: number): number => (entry.defs[i].parent < 0 ? 0 : 1 + depth(entry.defs[i].parent))
  const rows = entry.defs.map((def, i) => {
    const users = graph.inDegree.get(symbolKey(file, i)) ?? 0
    const usedBy = users > 0 ? `  ← ${users}` : ''
    return `${'  '.repeat(depth(i))}L${def.line}-${def.end} ${def.kind} ${def.sig || def.name}${usedBy}`
  })
  const header = `${file} — ${entry.lines} lines, ${entry.defs.length} symbols (← N = used by N symbols)`
  // A API pública numa linha: "o que este arquivo exporta" sem grep ^export.
  const exported = entry.defs.filter((d) => d.exported).map((d) => d.qual)
  const api = exported.length > 0 ? `\nExported (${exported.length}): ${exported.join(', ')}` : ''
  return rows.length > 0 ? `${header}${api}\n${rows.join('\n')}` : `${header}\n(no symbols found)`
}

/**
 * Orientação num repositório: pastas com contagem e os símbolos mais usados de
 * cada uma, mais os hotspots globais. Sai do grafo, sem LLM, em ~1-2k tokens.
 */
export function renderRepoMap(index: CodeIndex, opts: { maxDirs?: number; scope?: string } = {}): string {
  const graph = index.getGraph()
  const maxDirs = opts.maxDirs ?? 18
  const files = [...index.files.keys()].filter((f) => !opts.scope || inScope(f, opts.scope))
  if (files.length === 0) return 'No indexed source files here.'

  // Expande a pasta mais cheia até caber no orçamento: monorepo vira
  // apps/desktop/electron/lib, não "apps (2.000 arquivos)".
  const countUnder = (dir: string) => files.filter((f) => inScope(f, dir)).length
  const childDirs = (dir: string) => {
    const prefix = dir ? `${dir}/` : ''
    const children = new Set<string>()
    for (const f of files) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash > 0) children.add(prefix + rest.slice(0, slash))
    }
    return [...children]
  }
  let dirs = childDirs(opts.scope?.replace(/\/+$/, '') ?? '')
  if (dirs.length === 0) dirs = ['']
  for (let guard = 0; guard < 40; guard++) {
    const biggest = dirs
      .map((d) => ({ d, n: countUnder(d), kids: childDirs(d) }))
      .filter((x) => x.kids.length > 0)
      .sort((a, b) => b.n - a.n)[0]
    if (!biggest || dirs.length - 1 + biggest.kids.length > maxDirs) break
    if (biggest.n < files.length / (maxDirs * 2)) break
    dirs = [...dirs.filter((d) => d !== biggest.d), ...biggest.kids]
  }

  const ranked = (filter: (file: string) => boolean, n: number) =>
    [...graph.inDegree.entries()]
      .filter(([k]) => filter(parseKey(k).file))
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)

  const rows = dirs
    .map((dir) => ({ dir, n: countUnder(dir) }))
    .sort((a, b) => b.n - a.n)
    .map(({ dir, n }) => {
      const hubs = ranked((f) => inScope(f, dir) && !isTestFile(f), 3).map(([k]) => {
        const { file, def } = parseKey(k)
        return index.files.get(file)?.defs[def]?.qual
      })
      const langs = [...new Set(files.filter((f) => inScope(f, dir)).map((f) => index.files.get(f)!.lang))].slice(0, 3)
      return `${dir || '.'}/  ${n} files (${langs.join(', ')})${hubs.length ? ` — hubs: ${hubs.join(', ')}` : ''}`
    })

  const hotspots = ranked((f) => !isTestFile(f), 10).map(([k, n]) => `  ${labelFor(index, k)} ← ${n}`)
  return [
    `${files.length} source files indexed in ${index.root}`,
    ...rows,
    '',
    'Most-used symbols (← N = used by N symbols):',
    ...hotspots,
  ].join('\n')
}

/** Resolve o que o agente passou: arquivo, `Classe.metodo` ou nome simples. */
export function resolveSymbol(index: CodeIndex, query: string, scope?: string): SymbolKey[] {
  const graph = index.getGraph()
  const clean = query.trim().replace(/\(\)$/, '').replace(/::/g, '.')
  const file = clean.replace(/^\.\//, '')
  if (index.files.has(file)) return index.files.get(file)!.defs.map((_, i) => symbolKey(file, i)).concat(symbolKey(file, -1))
  let keys: SymbolKey[]
  if (clean.includes('.') && !/\.\w{1,4}$/.test(clean)) {
    const last = clean.slice(clean.lastIndexOf('.') + 1)
    keys = (graph.byName.get(last) ?? []).filter((k) => {
      const { file: f, def } = parseKey(k)
      const qual = index.files.get(f)?.defs[def]?.qual ?? ''
      return qual === clean || qual.endsWith(`.${clean}`)
    })
  } else {
    keys = graph.byName.get(clean) ?? []
  }
  return scope ? keys.filter((k) => inScope(parseKey(k).file, scope)) : keys
}

export interface RefsOptions {
  direction: 'in' | 'out'
  depth: number
}

/**
 * Quem usa (in) ou o que é usado (out). Profundidade 1 lista cada aresta com
 * a linha; mais fundo vira o raio de impacto agrupado por arquivo — é a lista
 * de arquivos para conferir antes de um refactor.
 */
export function renderRefs(index: CodeIndex, start: SymbolKey[], opts: RefsOptions): string {
  const graph = index.getGraph()
  const edgesOf = (key: SymbolKey): Edge[] =>
    (opts.direction === 'in' ? graph.incoming.get(key) : graph.outgoing.get(key)) ?? []
  const other = (e: Edge) => (opts.direction === 'in' ? e.from : e.to)
  const startSet = new Set(start)

  // Linhas de cada vizinho direto (a linha é sempre a do uso, no arquivo de quem usa).
  const direct = new Map<SymbolKey, { lines: number[]; sure: boolean; at: string }>()
  for (const key of start) {
    for (const edge of edgesOf(key)) {
      const target = other(edge)
      if (startSet.has(target)) continue
      const entry = direct.get(target)
      if (entry) {
        entry.lines.push(edge.line)
        entry.sure &&= edge.sure
      } else {
        direct.set(target, { lines: [edge.line], sure: edge.sure, at: parseKey(edge.from).file })
      }
    }
  }

  if (opts.depth <= 1) {
    if (direct.size === 0) return opts.direction === 'in' ? 'No uses found in the index.' : 'Uses nothing else in the index.'
    // Agrupado por quem usa, com TODAS as linhas: uma linha por vizinho, e
    // nenhuma chamada some (createVideoTools → 11 linhas, não só a primeira).
    const rows = [...direct]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([target, { lines, sure, at }]) => `  ${nameOf(index, target)} — ${at}:${lineList(lines, 12)}${sure ? '' : '  (~ same name elsewhere)'}`)
    const total = [...direct.values()].reduce((n, d) => n + new Set(d.lines).size, 0)
    const files = new Set([...direct.keys()].map((k) => parseKey(k).file)).size
    const head =
      opts.direction === 'in'
        ? `${total} uses in ${direct.size} symbols across ${files} files:`
        : `${direct.size} dependencies (${total} uses):`
    return [head, ...rows.slice(0, 80), rows.length > 80 ? `  … +${rows.length - 80}` : ''].filter(Boolean).join('\n')
  }

  const level = new Map<SymbolKey, number>()
  let frontier = start
  for (let d = 1; d <= opts.depth && frontier.length > 0; d++) {
    const next: SymbolKey[] = []
    for (const key of frontier) {
      for (const edge of edgesOf(key)) {
        const target = other(edge)
        if (startSet.has(target) || level.has(target)) continue
        level.set(target, d)
        // O topo de um arquivo não propaga: "o arquivo importa X" não faz de
        // todo o resto do arquivo um dependente.
        if (parseKey(target).def >= 0) next.push(target)
      }
    }
    frontier = next
  }
  if (level.size === 0) return opts.direction === 'in' ? 'No uses found in the index.' : 'Uses nothing else in the index.'

  const byFile = new Map<string, Array<{ name: string; d: number }>>()
  for (const [key, d] of level) {
    const { file } = parseKey(key)
    // Vizinho direto leva as linhas do uso: dá para abrir sem outro code_refs.
    const lines = d === 1 && opts.direction === 'in' ? direct.get(key)?.lines : undefined
    const name = nameOf(index, key) + (lines ? `:${lineList(lines, 4)}` : '')
    const list = byFile.get(file)
    if (list) list.push({ name, d })
    else byFile.set(file, [{ name, d }])
  }
  const rows = [...byFile.entries()]
    .sort((a, b) => Math.min(...a[1].map((x) => x.d)) - Math.min(...b[1].map((x) => x.d)) || b[1].length - a[1].length)
    .map(([file, list]) => {
      const names = list.sort((a, b) => a.d - b.d).map((x) => (x.d > 1 ? `${x.name}°${x.d}` : x.name))
      const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` +${names.length - 6}` : '')
      return `  ${file}: ${shown}`
    })
  const verb = opts.direction === 'in' ? 'affected' : 'reached'
  return [
    `${level.size} symbols ${verb} in ${byFile.size} files (°N = N hops away):`,
    ...rows.slice(0, 60),
    rows.length > 60 ? `  … +${rows.length - 60} files` : '',
  ].filter(Boolean).join('\n')
}

/**
 * Depois de um edit: se a assinatura de algo mudou (ou sumiu), quem o usa em
 * OUTRO arquivo. Silencioso no caso comum — editar corpo de função não gera
 * aviso nenhum, então não custa token à toa.
 */
export function signatureChanges(
  index: CodeIndex,
  graph: CodeGraph,
  file: string,
  before: SymbolDef[],
): string {
  const after = index.files.get(file)?.defs ?? []
  const now = new Map(after.map((d) => [d.qual, d.sig]))
  const notes: string[] = []
  before.forEach((def, i) => {
    if (now.get(def.qual) === def.sig) return
    const users = (graph.incoming.get(symbolKey(file, i)) ?? []).filter((e) => parseKey(e.from).file !== file)
    if (users.length === 0) return
    const files = [...new Set(users.map((e) => `${parseKey(e.from).file}:${e.line}`))]
    const what = now.has(def.qual) ? 'signature changed' : 'removed/renamed'
    notes.push(`- ${def.qual} (${what}) is used in ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` +${files.length - 5}` : ''}`)
  })
  return notes.length > 0 ? `\n\nCheck these callers in other files:\n${notes.join('\n')}` : ''
}
