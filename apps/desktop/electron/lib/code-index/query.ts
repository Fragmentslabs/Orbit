import fs from 'node:fs/promises'
import path from 'node:path'
import type { SymbolDef } from './extract'
import { parseKey, symbolKey, type CodeGraph, type CodeIndex, type Edge, type SymbolKey } from './store'

/**
 * The queries that become tools. All of them return compact text with an exact
 * `file:line` — the goal is for the agent to reach the right excerpt without
 * the grep → read → read round trip it would do on its own.
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

/** Simple plural (tools → tool, entries → entry): enough for code names. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

/** Tests and mocks answer the same search as real code, but are rarely what is being looked for. */
export const isTestFile = (file: string) => /(^|\/)(__tests__|tests?|__mocks__)\/|\.(test|spec)\.[^.]+$/.test(file)

interface SearchDoc {
  key: SymbolKey
  def: SymbolDef
  file: string
  name: Set<string>
  where: Set<string>
  about: Set<string>
  /** Names the definition uses in its body (`model.limit.context` → limit, context). */
  body: Set<string>
}

/** The search documents live next to the graph: both change only when the index changes. */
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

/** Matches term and token; a common prefix (≥4) counts partially — `index` finds `indexer`, `pars` finds `parse`. */
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
 * The body weighs little and counts as half a term in the coverage: it connects "context
 * limit" to whoever reads `model.limit.context`, without letting a 1,000-line
 * function (which uses everything) match any search.
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
  // IDF: a term that appears in every symbol (e.g. the project name) discriminates nothing.
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

/** Folder prefix by segment: `src/a` covers `src/a/x.ts`, not `src/ab.ts`. */
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
 * Up to 3 who-uses, with the line of the CALL (not the line of the definition of the caller):
 * that is the line the agent is going to open.
 */
function usersLine(graph: CodeGraph, key: SymbolKey, index: CodeIndex): string {
  const firstCall = new Map<SymbolKey, number>()
  for (const edge of graph.incoming.get(key) ?? []) {
    const known = firstCall.get(edge.from)
    if (known === undefined || edge.line < known) firstCall.set(edge.from, edge.line)
  }
  if (firstCall.size === 0) return ''
  // "who → file:line of the call": the format says on its own that the line is the one
  // of the use — in the benchmark the agent read "(file:line)" as the definition of
  // the caller and went after the call site with grep.
  const shown = [...firstCall].slice(0, 3).map(([from, line]) => `${nameOf(index, from)} → ${parseKey(from).file}:${line}`)
  const more = firstCall.size > 3 ? ` +${firstCall.size - 3}` : ''
  return `called at: ${shown.join(', ')}${more}`
}

function nameOf(index: CodeIndex, key: SymbolKey): string {
  const { file, def } = parseKey(key)
  return def < 0 ? '(top level)' : index.files.get(file)?.defs[def]?.qual ?? '?'
}

/** `137, 293, 306 +8`: the lines of one who-uses, compact. */
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

/** Results that come with code; the others only with a header and a signature. */
const EXCERPT_HITS = 3
const EXCERPT_LINES = 8

/**
 * The first results bring the beginning of the code; the rest, only where it is and
 * the signature. Code in a result the agent will not use is context
 * paid for in every following step of the turn.
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

/** Signatures of a file with the line range — the file without the bodies. */
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
  // The public API on one line: "what this file exports" without a ^export grep.
  const exported = entry.defs.filter((d) => d.exported).map((d) => d.qual)
  const api = exported.length > 0 ? `\nExported (${exported.length}): ${exported.join(', ')}` : ''
  return rows.length > 0 ? `${header}${api}\n${rows.join('\n')}` : `${header}\n(no symbols found)`
}

/**
 * Orientation in a repository: folders with their count and the most used symbols of
 * each one, plus the global hotspots. Comes out of the graph, with no LLM, in ~1-2k tokens.
 */
export function renderRepoMap(index: CodeIndex, opts: { maxDirs?: number; scope?: string } = {}): string {
  const graph = index.getGraph()
  const maxDirs = opts.maxDirs ?? 18
  const files = [...index.files.keys()].filter((f) => !opts.scope || inScope(f, opts.scope))
  if (files.length === 0) return 'No indexed source files here.'

  // Expand the fullest folder until it fits the budget: a monorepo becomes
  // apps/desktop/electron/lib, not "apps (2,000 files)".
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

/** Resolves what the agent passed: file, `Class.method` or a plain name. */
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
 * Who uses (in) or what is used (out). Depth 1 lists each edge with
 * the line; deeper becomes the blast radius grouped by file — it is the list
 * of files to check before a refactor.
 */
export function renderRefs(index: CodeIndex, start: SymbolKey[], opts: RefsOptions): string {
  const graph = index.getGraph()
  const edgesOf = (key: SymbolKey): Edge[] =>
    (opts.direction === 'in' ? graph.incoming.get(key) : graph.outgoing.get(key)) ?? []
  const other = (e: Edge) => (opts.direction === 'in' ? e.from : e.to)
  const startSet = new Set(start)

  // Lines of each direct neighbor (the line is always the one of the use, in the file of whoever uses it).
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
    // Grouped by who uses it, with ALL the lines: one line per neighbor, and
    // no call goes missing (createVideoTools → 11 lines, not just the first).
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
        // The top of a file does not propagate: "the file imports X" does not make
        // all the rest of the file a dependent.
        if (parseKey(target).def >= 0) next.push(target)
      }
    }
    frontier = next
  }
  if (level.size === 0) return opts.direction === 'in' ? 'No uses found in the index.' : 'Uses nothing else in the index.'

  const byFile = new Map<string, Array<{ name: string; d: number }>>()
  for (const [key, d] of level) {
    const { file } = parseKey(key)
    // A direct neighbor brings the lines of the use: enough to open it without another code_refs.
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
 * After an edit: whether the signature of something changed (or vanished), and who uses it in
 * ANOTHER file. Silent in the common case — editing a function body generates
 * no warning at all, so it does not cost tokens for nothing.
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
