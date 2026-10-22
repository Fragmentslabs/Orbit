import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

/**
 * A busca do espaço de trabalho: um índice de nomes e uma varredura de texto.
 *
 * É o motor de UM lugar só, usado por quem procura arquivo pelo nome (a paleta
 * do `@`, o campo do painel, o modal) e por quem procura dentro do código. O
 * índice é a peça que os dois compartilham: quem quer nomes filtra memória;
 * quem quer ocorrências percorre a MESMA lista, sem uma segunda caminhada.
 *
 * A camada de ignore é o ponto crítico. Sem ela o custo deixa de ser o texto do
 * projeto e passa a ser o que existe em volta dele: num checkout real deste
 * repo, 56 mil arquivos (524 ms só para listar) contra 1,1 mil de código (14
 * ms) — e os primeiros 2.000 que a paleta do `@` via eram 1.985 arquivos de
 * CMake dentro de `.whisper-build`. Ignorar saída de build não é otimização:
 * é o que faz a busca enxergar o projeto.
 */

/**
 * Pastas que nenhuma varredura atravessa — por custo, não por segredo.
 *
 * A árvore do painel continua mostrando todas (lá cada pasta só é lida quando
 * alguém a abre); esta lista vale só para o que percorre o espaço inteiro.
 */
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  // caches e ambientes isolados
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.gradle',
  '.expo',
  '.dart_tool',
  '.pytest_cache',
  '.mypy_cache',
  '.cxx',
  '.idea',
  // Saída de build — é aqui que mora o grosso do custo. `build` inclusive:
  // no projeto mobile ele guarda 6,4 GB e ~30 mil arquivos intermediários do
  // Xcode, e sozinho respondia por 94% do índice.
  'build',
  'dist',
  'dist-electron',
  'release',
  'out',
  'coverage',
  'target',
  'vendor',
  // builds nativos: Pods do iOS, artefatos de swift/cmake e DerivedData
  'Pods',
  'DerivedData',
  '.whisper-build',
])

/** Nomes que não são tamanho fixo de diretório, mas prefixo (`cmake-build-debug`). */
const SKIPPED_PREFIXES = ['cmake-build', 'build-']

function isSkippedDir(name: string): boolean {
  if (SKIPPED_DIRS.has(name)) return true
  return SKIPPED_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** Teto do índice. Um workspace maior que isto está fora do que a UI promete. */
const MAX_INDEX_FILES = 40_000
/** O índice é barato de refazer (14 ms medidos), então vive pouco no cache. */
const INDEX_TTL_MS = 2_000

interface WorkspaceIndex {
  files: string[]
  truncated: boolean
  at: number
}

const indexes = new Map<string, WorkspaceIndex>()

export interface WorkspaceIndexResult {
  files: string[]
  truncated: boolean
}

/**
 * A lista de arquivos do espaço, relativa à raiz e ordenada.
 *
 * Caminhada iterativa de propósito: recursão com `push(...await ...)` estoura a
 * pilha em pasta funda e monta um array intermediário por diretório.
 */
export async function workspaceIndex(
  root: string,
  options: { refresh?: boolean } = {},
): Promise<WorkspaceIndexResult> {
  const cached = indexes.get(root)
  if (!options.refresh && cached && Date.now() - cached.at < INDEX_TTL_MS) {
    return { files: cached.files, truncated: cached.truncated }
  }

  const files: string[] = []
  let truncated = false
  const stack: string[] = ['']

  while (stack.length > 0 && !truncated) {
    const relDir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name)) continue
        stack.push(relDir ? `${relDir}/${entry.name}` : entry.name)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= MAX_INDEX_FILES) {
        truncated = true
        break
      }
      files.push(relDir ? `${relDir}/${entry.name}` : entry.name)
    }
  }

  files.sort()
  indexes.set(root, { files, truncated, at: Date.now() })
  return { files, truncated }
}

export interface NameHit {
  /** Caminho relativo à raiz — o que a UI mostra e devolve ao abrir. */
  path: string
  name: string
  dir: string
}

/**
 * Nomes de arquivo que contêm a consulta.
 *
 * O ranqueamento é o que separa "achei" de "achei o que eu queria": nome que
 * COMEÇA com a consulta vem antes de nome que a contém no meio, e o nome exato
 * antes de tudo. Sem isso, procurar `files` devolve `files.test.ts` na frente
 * de `files.ts`.
 */
export function matchNames(files: string[], query: string, limit = 60): NameHit[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []

  const scored: { hit: NameHit; score: number; length: number }[] = []
  for (const rel of files) {
    const cut = rel.lastIndexOf('/')
    const name = cut === -1 ? rel : rel.slice(cut + 1)
    const at = name.toLowerCase().indexOf(q)
    if (at === -1) continue
    const score = at > 0 ? 2 : name.length === q.length ? 0 : 1
    scored.push({
      hit: { path: rel, name, dir: cut === -1 ? '' : rel.slice(0, cut) },
      score,
      length: rel.length,
    })
  }

  scored.sort((a, b) => a.score - b.score || a.length - b.length)
  return scored.slice(0, limit).map((entry) => entry.hit)
}

export interface LineHit {
  /** 1-based, como o editor conta. */
  line: number
  column: number
  text: string
  length: number
}

export interface FileHits {
  path: string
  /** Todas as ocorrências do arquivo, mesmo as que não voltam em `lines`. */
  count: number
  lines: LineHit[]
}

export interface TextSearchResult {
  occurrences: FileHits[]
  /** Arquivos de texto realmente lidos. */
  scanned: number
  matches: number
  truncated: boolean
  /** Regex inválida: não é falha da busca, é consulta pela metade. */
  invalidPattern?: boolean
}

export interface MatchOptions {
  caseSensitive?: boolean
  regex?: boolean
  /** A ocorrência só vale isolada: `file` não casa dentro de `walkFiles`. */
  wholeWord?: boolean
  /**
   * Herda o formato do texto encontrado na substituição — `File` vira
   * `Document`, `FILE` vira `DOCUMENT`. Sem isso, renomear um símbolo em
   * arquivos que o usam em constantes e em classes estraga a convenção.
   */
  preserveCase?: boolean
}

/** Extensões que valem varrer. Lista branca, não negra: binário desconhecido
 *  fica de fora sem precisar abrir para descobrir. */
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'json', 'jsonc', 'json5',
  'css', 'scss', 'sass', 'less',
  'html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'astro',
  'md', 'mdx', 'txt', 'rst',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'm', 'mm',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'lua', 'pl', 'r', 'dart', 'scala', 'clj',
  'sql', 'graphql', 'gql', 'prisma',
  'tf', 'tfvars', 'dockerfile', 'gitignore', 'env', 'editorconfig',
])

/** Nomes sem extensão que são texto (e que a lista de extensões não pega). */
const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile',
  'cmakelists.txt', 'license', 'notice', 'readme',
])

/** Acima disto o arquivo é bundle, minificado ou dado — não é fonte. */
const MAX_SEARCH_BYTES = 1024 * 1024
/** Quantas linhas de um mesmo arquivo voltam para a UI. */
const MAX_LINES_PER_FILE = 12
/** Teto de ocorrências contadas na varredura inteira. */
const MAX_MATCHES = 2_000

function isTextCandidate(relPath: string): boolean {
  const cut = relPath.lastIndexOf('/')
  const name = (cut === -1 ? relPath : relPath.slice(cut + 1)).toLowerCase()
  const dot = name.lastIndexOf('.')
  // `dot > 0` deixa `.env` cair na regra de dotfile em vez de virar "sem ext".
  if (dot > 0) return TEXT_EXTENSIONS.has(name.slice(dot + 1))
  if (name.startsWith('.')) return true
  return TEXT_NAMES.has(name)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildRegExp(query: string, options: MatchOptions): RegExp | null {
  try {
    return new RegExp(query, options.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}

/**
 * O casador final da busca: consulta literal, literal com fronteira de palavra
 * ou regex.
 *
 * `\b` sozinho erraria onde a busca mais importa — em `snake_case` e depois de
 * dígito o `\b` não separa nada, porque `_` conta como letra. As fronteiras vão
 * explícitas (`\w` nas laterais) para que "file" não case em "walkFiles" nem
 * "file_2", mas case em "the file.".
 */
function buildMatcher(query: string, options: MatchOptions): RegExp | null {
  if (options.regex) return buildRegExp(query, options)
  const escaped = escapeRegExp(query)
  return buildRegExp(options.wholeWord ? `(?<!\\w)${escaped}(?!\\w)` : escaped, options)
}

/** Devolve a substituição no formato do texto que ela está trocando. */
function applyCase(matched: string, replacement: string): string {
  if (replacement === '' || matched === '') return replacement
  const upper = matched.toUpperCase()
  const lower = matched.toLowerCase()
  // Só tem caixa quando mudar de forma muda o texto (`123` não tem).
  if (upper === lower) return replacement
  if (matched === upper) return replacement.toUpperCase()
  if (matched === lower) return replacement.toLowerCase()
  const rest = matched.slice(1)
  if (matched[0] === matched[0].toUpperCase() && rest === rest.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  }
  return replacement
}

/**
 * Varre o texto dos arquivos do índice atrás da consulta.
 *
 * O custo é lido antes de ser pago: só entram candidatos de texto, menores que
 * 1 MB, e a função devolve resultado PARCIAL — as primeiras ocorrências valem
 * mais que a contagem completa, e a UI mostra o que chegou. `signal` é checado
 * a cada arquivo: uma tecla nova cancela a varredura anterior no meio, em vez
 * de enfileirar trabalho que ninguém vai ver.
 */
export async function searchText(
  root: string,
  files: string[],
  query: string,
  options: MatchOptions,
  signal?: AbortSignal,
): Promise<TextSearchResult> {
  const q = query.trim()
  const result: TextSearchResult = { occurrences: [], scanned: 0, matches: 0, truncated: false }
  if (q === '') return result

  // Com palavra inteira o caminho rápido do `indexOf` não serve — a fronteira
  // precisa ser olhada —, então os dois casos passam pelo mesmo casador.
  const usePattern = options.regex === true || options.wholeWord === true
  const pattern = usePattern ? buildMatcher(q, options) : null
  if (usePattern && !pattern) {
    result.invalidPattern = true
    return result
  }
  const needle = options.caseSensitive ? q : q.toLowerCase()

  for (const rel of files) {
    if (signal?.aborted) return result
    if (!isTextCandidate(rel)) continue

    const absolute = path.join(root, rel)
    let buffer: Buffer
    try {
      const stat = await fs.stat(absolute)
      if (!stat.isFile() || stat.size > MAX_SEARCH_BYTES) continue
      buffer = await fs.readFile(absolute)
    } catch {
      continue
    }
    // Binário disfarçado de texto (extensão mentirosa): o NUL denuncia.
    if (buffer.subarray(0, 8000).includes(0)) continue

    result.scanned += 1
    const lines = buffer.toString('utf8').split('\n')
    let fileCount = 0
    const hits: LineHit[] = []

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (usePattern && pattern) {
        pattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = pattern.exec(line)) !== null) {
          fileCount += 1
          if (hits.length < MAX_LINES_PER_FILE) {
            hits.push({ line: i + 1, column: match.index + 1, text: line, length: match[0].length })
          }
          // Regex que casa vazio (`a*`) entraria em laço infinito.
          if (match[0].length === 0) pattern.lastIndex += 1
          if (fileCount >= MAX_MATCHES) break
        }
      } else {
        const haystack = options.caseSensitive ? line : line.toLowerCase()
        let from = 0
        let at = haystack.indexOf(needle, from)
        while (at !== -1) {
          fileCount += 1
          if (hits.length < MAX_LINES_PER_FILE) {
            hits.push({ line: i + 1, column: at + 1, text: line, length: q.length })
          }
          from = at + Math.max(1, q.length)
          if (fileCount >= MAX_MATCHES) break
          at = haystack.indexOf(needle, from)
        }
      }
      if (fileCount >= MAX_MATCHES) break
    }

    if (fileCount > 0) {
      result.matches += fileCount
      result.occurrences.push({ path: rel, count: fileCount, lines: hits })
    }
    if (result.matches >= MAX_MATCHES) {
      result.truncated = true
      break
    }
  }

  // Mais ocorrências primeiro: quem procura um símbolo quer o arquivo que fala
  // dele, não o que o cita de passagem.
  result.occurrences.sort((a, b) => b.count - a.count)
  return result
}

export interface ReplaceResult {
  files: number
  replacements: number
  /** Caminhos absolutos gravados — quem chama registra como save manual. */
  written: string[]
  errors: { path: string; error: string }[]
}

/**
 * Substitui em arquivos já escolhidos (a lista de ocorrências da busca).
 *
 * Grava só o que mudou, e só depois de o arquivo inteiro ter sido lido: um erro
 * no meio de um arquivo deixa os outros intactos em vez de gravar metade. Quem
 * chama decide QUAIS arquivos — o escopo é decisão da UI, não do motor.
 */
export async function replaceInFiles(
  root: string,
  targets: string[],
  query: string,
  replacement: string,
  options: MatchOptions,
  guard?: (absolutePath: string) => { ok: true } | { ok: false; reason: string },
): Promise<ReplaceResult> {
  const q = query.trim()
  const result: ReplaceResult = { files: 0, replacements: 0, written: [], errors: [] }
  if (q === '') return result

  const pattern = buildMatcher(q, options)
  if (!pattern) {
    result.errors.push({ path: '', error: 'invalid-pattern' })
    return result
  }

  for (const rel of targets) {
    const absolute = path.join(root, rel)
    if (guard) {
      const verdict = guard(absolute)
      if (!verdict.ok) {
        result.errors.push({ path: rel, error: verdict.reason })
        continue
      }
    }
    try {
      const stat = await fs.stat(absolute)
      if (!stat.isFile() || stat.size > MAX_SEARCH_BYTES) continue
      const before = await fs.readFile(absolute, 'utf8')
      let count = 0
      const after = before.replace(pattern, (matched) => {
        count += 1
        return options.preserveCase ? applyCase(matched, replacement) : replacement
      })
      if (count === 0) continue
      await fs.writeFile(absolute, after, 'utf8')
      result.files += 1
      result.replacements += count
      result.written.push(absolute)
    } catch (err) {
      result.errors.push({ path: rel, error: (err as Error).message })
    }
  }

  return result
}

/** Depois de uma substituição o índice envelheceu (nomes são os mesmos, o
 *  conteúdo não — mas o próximo pedido pode ser de outro canto). */
export function invalidateIndex(root: string): void {
  indexes.delete(root)
}
