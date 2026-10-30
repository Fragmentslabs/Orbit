import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { IGNORED_DIRS } from '../tools/context'
import { languageFor } from './languages'
import { extractFacts, UseKind, type FileFacts, type SymbolDef } from './extract'
import { perfSpan } from '../perf'

/**
 * Code index of a folder: symbols per file + the graph of uses.
 *
 * Fresh by construction: every query goes through `refresh()`, which compares the
 * mtime/size of each file and re-extracts only what changed (uncommitted
 * edits included). The result goes to disk, so reopening the app on a
 * folder already seen costs one stat per file, not a parse.
 */

const execFileAsync = promisify(execFile)

/** Changes when the persisted format or the extraction change — forces re-extracting everything. */
const FORMAT = 4
const MAX_FILES = 30_000
const MAX_FILE_BYTES = 1024 * 1024
/** Below this, back-to-back queries reuse the last refresh. */
const REFRESH_THROTTLE_MS = 1500
/** Names with more definitions than this, with no import hint, do not become an edge. */
const MAX_AMBIGUOUS = 4

export interface FileEntry extends FileFacts {
  mtime: number
  size: number
}

/** Symbol key: `file#index`; `file#-1` is the top of the file. */
export type SymbolKey = string

export interface Edge {
  from: SymbolKey
  to: SymbolKey
  line: number
  /** false when the name exists in several places and no import broke the tie. */
  sure: boolean
}

export interface CodeGraph {
  byName: Map<string, SymbolKey[]>
  incoming: Map<SymbolKey, Edge[]>
  outgoing: Map<SymbolKey, Edge[]>
  /** How many distinct symbols use each symbol for sure (apart from itself) — the basis of the ranking and of the hubs. */
  inDegree: Map<SymbolKey, number>
}

export const symbolKey = (file: string, def: number): SymbolKey => `${file}#${def}`

export function parseKey(key: SymbolKey): { file: string; def: number } {
  const at = key.lastIndexOf('#')
  return { file: key.slice(0, at), def: Number(key.slice(at + 1)) }
}

let cacheDirOverride: string | null | undefined

/** Tests point the cache at a tmp dir (or turn it off with null). */
export function setCodeIndexCacheDir(dir: string | null) {
  cacheDirOverride = dir
}

async function cacheDir(): Promise<string | null> {
  if (cacheDirOverride !== undefined) return cacheDirOverride
  try {
    const { app } = await import('electron')
    return path.join(app.getPath('userData'), 'orbit-data', 'code-index')
  } catch {
    return null
  }
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

export class CodeIndex {
  readonly root: string
  files = new Map<string, FileEntry>()
  private graph: CodeGraph | null = null
  private loaded = false
  private lastRefresh = 0
  private running: Promise<void> | null = null
  private persistTimer: NodeJS.Timeout | null = null

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  /** Something is already indexed — no first-build cost. */
  get warm(): boolean {
    return this.files.size > 0
  }

  async refresh(abort?: AbortSignal): Promise<void> {
    if (this.running) return this.running
    if (Date.now() - this.lastRefresh < REFRESH_THROTTLE_MS) return
    // One index per ROOT and they all live in the same process: with a worktree per
    // worker the scan is also what multiplies the heap, so it gets a record.
    const perf = perfSpan('index:scan', { root: this.root })
    this.running = this.scan(abort).finally(() => {
      this.running = null
      this.lastRefresh = Date.now()
      perf.end({ files: this.files.size })
    })
    return this.running
  }

  /** Re-extracts one file right now (after an edit), without waiting for the throttle. */
  async touch(relPath: string): Promise<void> {
    const changed = await this.update(relPath)
    if (changed) this.invalidate()
  }

  getGraph(): CodeGraph {
    if (!this.graph) this.graph = buildGraph(this.files)
    return this.graph
  }

  private invalidate() {
    this.graph = null
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => void this.persist(), 2000)
    this.persistTimer.unref?.()
  }

  private async scan(abort?: AbortSignal) {
    if (!this.loaded) {
      this.loaded = true
      await this.load()
    }
    const listed = await listSourceFiles(this.root, abort)
    let changed = false
    const present = new Set(listed)
    for (const rel of this.files.keys()) {
      if (!present.has(rel)) {
        this.files.delete(rel)
        changed = true
      }
    }
    let lastYield = Date.now()
    for (let i = 0; i < listed.length; i += 64) {
      if (abort?.aborted) break
      const batch = listed.slice(i, i + 64)
      const results = await Promise.all(batch.map((rel) => this.update(rel)))
      if (results.some(Boolean)) changed = true
      // The parse runs in the main process: yield the loop so the UI does not freeze
      // on the first indexing of a large repository.
      if (Date.now() - lastYield > 12) {
        await yieldToLoop()
        lastYield = Date.now()
      }
    }
    if (changed) this.invalidate()
  }

  /** true when the file entered, changed or left the index. */
  private async update(rel: string): Promise<boolean> {
    const full = path.join(this.root, rel)
    let stat
    try {
      stat = await fs.stat(full)
    } catch {
      return this.files.delete(rel)
    }
    const known = this.files.get(rel)
    if (known && known.mtime === stat.mtimeMs && known.size === stat.size) return false
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return this.files.delete(rel)
    let facts: FileFacts | null = null
    try {
      const source = await fs.readFile(full, 'utf8')
      if (!looksGenerated(source)) facts = await extractFacts(rel, source)
    } catch {
      facts = null
    }
    if (!facts) return this.files.delete(rel)
    this.files.set(rel, { ...facts, mtime: stat.mtimeMs, size: stat.size })
    return true
  }

  private async cacheFile(): Promise<string | null> {
    const dir = await cacheDir()
    if (!dir) return null
    const id = createHash('sha1').update(this.root).digest('hex').slice(0, 16)
    return path.join(dir, `${id}.json`)
  }

  private async load() {
    const file = await this.cacheFile()
    if (!file) return
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'))
      if (data.format !== FORMAT || data.root !== this.root) return
      this.files = new Map(data.files)
    } catch {
      // no cache (first time) or corrupted cache: rebuild from scratch
    }
  }

  private async persist() {
    const file = await this.cacheFile()
    if (!file) return
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, JSON.stringify({ format: FORMAT, root: this.root, files: [...this.files] }))
      await fs.rename(tmp, file)
    } catch {
      // the cache is an optimization: failing to write only costs a parse next time
    }
  }
}

/** Minified/generated: huge lines have no useful symbols and bloat the index. */
function looksGenerated(source: string): boolean {
  if (source.length < 4000) return false
  const newlines = source.split('\n').length
  return source.length / newlines > 400
}

function isIndexable(rel: string): boolean {
  const parts = rel.split('/')
  if (parts.some((p) => IGNORED_DIRS.has(p))) return false
  if (/\.min\.[cm]?js$/.test(rel)) return false
  return languageFor(path.extname(rel)) !== null
}

/**
 * Code files of the folder. In a git repository, git itself lists them —
 * it respects the .gitignore (which a manual walk does not) and includes new files
 * not yet committed. Outside git, a walk that skips the usual folders.
 */
async function listSourceFiles(root: string, abort?: AbortSignal): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 128 * 1024 * 1024, timeout: 15_000, signal: abort },
    )
    const files = [...new Set(stdout.split('\0'))].filter((f) => f && isIndexable(f))
    return files.slice(0, MAX_FILES)
  } catch {
    return walk(root, abort)
  }
}

async function walk(root: string, abort?: AbortSignal): Promise<string[]> {
  const out: string[] = []
  const stack = ['']
  while (stack.length > 0 && out.length < MAX_FILES) {
    if (abort?.aborted) break
    const rel = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile() && isIndexable(child)) out.push(child)
    }
  }
  return out
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

const JS_LANGS = new Set(['typescript', 'tsx', 'javascript'])

function withExtensions(base: string): string[] {
  const stem = base.replace(/\.[cm]?jsx?$/, '')
  return [base, ...JS_EXTENSIONS.map((ext) => stem + ext), ...JS_EXTENSIONS.map((ext) => `${base}/index${ext}`)]
}

/**
 * Import → file of the index. Relative: `./x` → `x.ts`, `./x.js` → `x.ts`,
 * `./dir` → `dir/index.ts`. Alias (`@shared/chat`, `~/lib/x`): the rest of the
 * path without the first segment, when a single file ends with it.
 * Package (`react`, `node:path`) → null: the name is from outside the project.
 */
function makeImportResolver(files: Map<string, FileEntry>) {
  const aliasMemo = new Map<string, string | null>()
  // Files by their last segment without extension (`a/b/chat.ts` → chat; `a/x/index.ts` → x):
  // the alias only compares a path with whoever has the right name, not with the whole repo.
  const byBase = new Map<string, string[]>()
  for (const key of files.keys()) {
    const parts = key.replace(/\.[^./]+$/, '').split('/')
    const base = parts[parts.length - 1] === 'index' && parts.length > 1 ? parts[parts.length - 2] : parts[parts.length - 1]
    const list = byBase.get(base)
    if (list) list.push(key)
    else byBase.set(base, [key])
  }
  return (from: string, spec: string): string | null => {
    if (spec.startsWith('.')) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
      return withExtensions(base).find((c) => files.has(c)) ?? null
    }
    const slash = spec.indexOf('/')
    if (slash < 0 || spec.includes(':')) return null
    let memo = aliasMemo.get(spec)
    if (memo === undefined) {
      const rest = spec.slice(slash + 1)
      const suffixes = withExtensions(rest).map((s) => `/${s}`)
      const base = rest.replace(/\.[cm]?jsx?$/, '').split('/').pop()!
      const found = (byBase.get(base) ?? []).filter((k) => suffixes.some((s) => `/${k}`.endsWith(s)))
      memo = found.length === 1 ? found[0] : null
      aliasMemo.set(spec, memo)
    }
    return memo
  }
}

const TYPE_KINDS = new Set(['class', 'interface', 'type', 'enum'])
const isMember = (def: SymbolDef) => def.qual !== def.name

/**
 * Which definitions a use may mean, given the way the name was used:
 * `: Foo` is only a type; `x.foo` is only a member (method/field); a plain call
 * prefers what is top-level, but accepts a member (Java calls a method of its own
 * class without `this.`).
 */
function compatible(candidates: SymbolKey[], kind: UseKind, defOf: Map<SymbolKey, SymbolDef>, prefix: string): SymbolKey[] {
  if (kind === UseKind.Type) return candidates.filter((k) => TYPE_KINDS.has(defOf.get(k)!.kind))
  if (kind === UseKind.Member) return candidates.filter((k) => isMember(defOf.get(k)!))
  const top = candidates.filter((k) => !isMember(defOf.get(k)!))
  return top.length > 0 ? top : candidates.filter((k) => k.startsWith(prefix))
}

/**
 * Links each use to a definition. With no types, the tie-break is by proximity:
 * same file → imported files → a name rare enough to be it.
 * A common name with no hint at all (get, run, init…) does not become an edge: a wrong
 * edge costs the agent more than a missing one. Member access with no hint
 * (`arr.slice()` anywhere) comes in as uncertain — it shows up in code_refs
 * marked, but does not inflate the ranking of what is central.
 */
export function buildGraph(files: Map<string, FileEntry>): CodeGraph {
  const byName = new Map<string, SymbolKey[]>()
  const defOf = new Map<SymbolKey, SymbolDef>()
  for (const [file, entry] of files) {
    entry.defs.forEach((def, i) => {
      const key = symbolKey(file, i)
      defOf.set(key, def)
      const list = byName.get(def.name)
      if (list) list.push(key)
      else byName.set(def.name, [key])
    })
  }

  const incoming = new Map<SymbolKey, Edge[]>()
  const outgoing = new Map<SymbolKey, Edge[]>()
  const push = (map: Map<SymbolKey, Edge[]>, key: SymbolKey, edge: Edge) => {
    const list = map.get(key)
    if (list) list.push(edge)
    else map.set(key, [edge])
  }

  const resolveImport = makeImportResolver(files)
  for (const [file, entry] of files) {
    const imported = new Set<string>()
    for (const spec of entry.imports) {
      const target = resolveImport(file, spec)
      if (target) imported.add(target)
    }
    const boundTo = new Map<string, string | null>()
    for (const [name, spec] of entry.importNames ?? []) boundTo.set(name, resolveImport(file, spec))
    const locals = new Set(entry.locals ?? [])
    // In JS/TS every name from another file arrives through an import: with no import, it is a
    // runtime global (window, process) or an alias we do not resolve.
    const modular = JS_LANGS.has(entry.lang)
    const prefix = `${file}#`
    for (const [name, owner, line, kind = UseKind.Plain] of entry.uses) {
      const all = byName.get(name)
      if (!all) continue
      const candidates = compatible(all, kind, defOf, prefix)
      if (candidates.length === 0) continue
      const from = symbolKey(file, owner)
      let targets = candidates.filter((k) => k.startsWith(prefix))
      let sure = targets.length === 1
      if (targets.length === 0 && kind !== UseKind.Member) {
        // Name bound here: through an import, it can only be the one from the imported file
        // (or nothing, if it came from a package); through a parameter/local variable, it is local.
        if (boundTo.has(name)) {
          const source = boundTo.get(name)
          if (!source) continue
          targets = candidates.filter((k) => parseKey(k).file === source)
          if (targets.length === 0) continue
          sure = targets.length === 1
        } else if (locals.has(name) || modular) {
          continue
        }
      }
      if (targets.length === 0 && imported.size > 0) {
        targets = candidates.filter((k) => imported.has(parseKey(k).file))
        sure = targets.length === 1 && kind !== UseKind.Member
      }
      if (targets.length === 0) {
        if (candidates.length > (kind === UseKind.Member ? 2 : MAX_AMBIGUOUS)) continue
        targets = candidates
        sure = candidates.length === 1 && kind !== UseKind.Member
      }
      for (const to of targets) {
        if (to === from) continue
        const edge: Edge = { from, to, line, sure }
        push(outgoing, from, edge)
        push(incoming, to, edge)
      }
    }
  }

  const inDegree = new Map<SymbolKey, number>()
  for (const [key, edges] of incoming) {
    const users = new Set(edges.filter((e) => e.sure).map((e) => e.from)).size
    if (users > 0) inDegree.set(key, users)
  }
  return { byName, incoming, outgoing, inDegree }
}

const registry = new Map<string, CodeIndex>()
const MAX_ROOTS = 6

/** One index per folder, reused across conversations; the least used ones leave memory. */
export function getCodeIndex(root: string): CodeIndex {
  const key = path.resolve(root)
  let index = registry.get(key)
  if (index) {
    registry.delete(key)
  } else {
    index = new CodeIndex(key)
    if (registry.size >= MAX_ROOTS) registry.delete(registry.keys().next().value!)
  }
  registry.set(key, index)
  return index
}

/** The index only if it already exists in memory — for whoever must not pay for the build. */
export function peekCodeIndex(root: string): CodeIndex | null {
  return registry.get(path.resolve(root)) ?? null
}
