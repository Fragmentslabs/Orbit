import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { IGNORED_DIRS } from '../tools/context'
import { languageFor } from './languages'
import { extractFacts, UseKind, type FileFacts, type SymbolDef } from './extract'

/**
 * Índice de código de uma pasta: símbolos por arquivo + o grafo de usos.
 *
 * Fresco por construção: toda consulta passa por `refresh()`, que compara
 * mtime/tamanho de cada arquivo e re-extrai só o que mudou (edições não
 * commitadas incluídas). O resultado vai para disco, então reabrir o app numa
 * pasta já vista custa um stat por arquivo, não um parse.
 */

const execFileAsync = promisify(execFile)

/** Muda quando o formato persistido ou a extração mudam — força re-extrair tudo. */
const FORMAT = 4
const MAX_FILES = 30_000
const MAX_FILE_BYTES = 1024 * 1024
/** Abaixo disso, consultas seguidas reusam o último refresh. */
const REFRESH_THROTTLE_MS = 1500
/** Nomes com mais definições que isto, sem pista de import, não viram aresta. */
const MAX_AMBIGUOUS = 4

export interface FileEntry extends FileFacts {
  mtime: number
  size: number
}

/** Chave de símbolo: `arquivo#índice`; `arquivo#-1` é o topo do arquivo. */
export type SymbolKey = string

export interface Edge {
  from: SymbolKey
  to: SymbolKey
  line: number
  /** false quando o nome existe em vários lugares e nenhum import desempatou. */
  sure: boolean
}

export interface CodeGraph {
  byName: Map<string, SymbolKey[]>
  incoming: Map<SymbolKey, Edge[]>
  outgoing: Map<SymbolKey, Edge[]>
  /** Quantos símbolos distintos usam cada símbolo com certeza (fora ele mesmo) — base de ranking e hubs. */
  inDegree: Map<SymbolKey, number>
}

export const symbolKey = (file: string, def: number): SymbolKey => `${file}#${def}`

export function parseKey(key: SymbolKey): { file: string; def: number } {
  const at = key.lastIndexOf('#')
  return { file: key.slice(0, at), def: Number(key.slice(at + 1)) }
}

let cacheDirOverride: string | null | undefined

/** Testes apontam o cache para um tmp (ou desligam com null). */
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

  /** Já tem algo indexado — sem custo de primeira construção. */
  get warm(): boolean {
    return this.files.size > 0
  }

  async refresh(abort?: AbortSignal): Promise<void> {
    if (this.running) return this.running
    if (Date.now() - this.lastRefresh < REFRESH_THROTTLE_MS) return
    this.running = this.scan(abort).finally(() => {
      this.running = null
      this.lastRefresh = Date.now()
    })
    return this.running
  }

  /** Re-extrai um arquivo agora (depois de um edit), sem esperar o throttle. */
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
      // O parse roda no processo principal: cede o loop para a UI não travar
      // na primeira indexação de um repositório grande.
      if (Date.now() - lastYield > 12) {
        await yieldToLoop()
        lastYield = Date.now()
      }
    }
    if (changed) this.invalidate()
  }

  /** true quando o arquivo entrou, mudou ou saiu do índice. */
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
      // sem cache (primeira vez) ou cache corrompido: reconstrói do zero
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
      // cache é otimização: falhar em gravar só custa um parse na próxima vez
    }
  }
}

/** Minificado/gerado: linhas enormes não têm símbolos úteis e incham o índice. */
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
 * Arquivos de código da pasta. Num repositório git, o próprio git lista —
 * respeita o .gitignore (o que um walk manual não faz) e inclui arquivos novos
 * ainda não commitados. Fora do git, um walk que pula as pastas de sempre.
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
 * Import → arquivo do índice. Relativo: `./x` → `x.ts`, `./x.js` → `x.ts`,
 * `./dir` → `dir/index.ts`. Alias (`@shared/chat`, `~/lib/x`): o resto do
 * caminho sem o primeiro segmento, quando um único arquivo termina nele.
 * Pacote (`react`, `node:path`) → null: o nome é de fora do projeto.
 */
function makeImportResolver(files: Map<string, FileEntry>) {
  const aliasMemo = new Map<string, string | null>()
  // Arquivos pelo último segmento sem extensão (`a/b/chat.ts` → chat; `a/x/index.ts` → x):
  // o alias só compara caminho com quem tem o nome certo, não com o repo inteiro.
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
 * Que definições um uso pode significar, pelo jeito como o nome foi usado:
 * `: Foo` só é tipo; `x.foo` só é membro (método/campo); chamada simples
 * prefere o que é de topo, mas aceita membro (Java chama método da própria
 * classe sem `this.`).
 */
function compatible(candidates: SymbolKey[], kind: UseKind, defOf: Map<SymbolKey, SymbolDef>, prefix: string): SymbolKey[] {
  if (kind === UseKind.Type) return candidates.filter((k) => TYPE_KINDS.has(defOf.get(k)!.kind))
  if (kind === UseKind.Member) return candidates.filter((k) => isMember(defOf.get(k)!))
  const top = candidates.filter((k) => !isMember(defOf.get(k)!))
  return top.length > 0 ? top : candidates.filter((k) => k.startsWith(prefix))
}

/**
 * Liga cada uso a uma definição. Sem tipos, o desempate é por proximidade:
 * mesmo arquivo → arquivos importados → nome raro o bastante para ser ele.
 * Nome comum sem pista nenhuma (get, run, init…) não vira aresta: uma aresta
 * errada custa mais ao agente do que uma que falta. Acesso a membro sem pista
 * (`arr.slice()` em qualquer lugar) entra como incerto — aparece em code_refs
 * marcado, mas não infla o ranking de quem é central.
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
    // Em JS/TS todo nome de outro arquivo chega por import: sem import, é
    // global do runtime (window, process) ou alias que não resolvemos.
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
        // Nome ligado aqui: por import, só pode ser o do arquivo importado
        // (ou nada, se veio de pacote); por parâmetro/variável local, é local.
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

/** Um índice por pasta, reaproveitado entre conversas; os menos usados saem da memória. */
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

/** O índice só se já existir em memória — para quem não deve pagar a construção. */
export function peekCodeIndex(root: string): CodeIndex | null {
  return registry.get(path.resolve(root)) ?? null
}
