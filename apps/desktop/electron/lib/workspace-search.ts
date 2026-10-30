import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

/**
 * The workspace search: an index of names and a text scan.
 *
 * It is the engine of a single place, used by whoever looks for a file by name (the `@`
 * palette, the panel field, the modal) and by whoever looks inside the code. The
 * index is the piece the two share: whoever wants names filters memory;
 * whoever wants occurrences walks the SAME list, without a second walk.
 *
 * The ignore layer is the critical point. Without it the cost stops being the project's
 * text and becomes what exists around it: in a real checkout of this
 * repo, 56 thousand files (524 ms just to list) against 1.1 thousand of code (14
 * ms) — and the first 2,000 that the `@` palette saw were 1,985 CMake files inside
 * `.whisper-build`. Ignoring build output is not optimization: it
 * is what makes the search see the project.
 */

/**
 * Folders that no scan goes through — for cost, not for secrecy.
 *
 * The panel tree still shows all of them (there each folder is only read when
 * someone opens it); this list counts only for what walks the whole space.
 */
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  // caches and isolated environments
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
  // Build output — that is where the bulk of the cost lives. `build` included:
  // in the mobile project it holds 6.4 GB and ~30 thousand intermediate Xcode
  // files, and alone accounted for 94% of the index.
  'build',
  'dist',
  'dist-electron',
  'release',
  'out',
  'coverage',
  'target',
  'vendor',
  // native builds: iOS Pods, swift/cmake artifacts and DerivedData
  'Pods',
  'DerivedData',
  '.whisper-build',
])

/** Names that are not a fixed directory size, but a prefix (`cmake-build-debug`). */
const SKIPPED_PREFIXES = ['cmake-build', 'build-']

function isSkippedDir(name: string): boolean {
  if (SKIPPED_DIRS.has(name)) return true
  return SKIPPED_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** Index ceiling. A workspace bigger than this is outside what the UI promises. */
const MAX_INDEX_FILES = 40_000
/** The index is cheap to rebuild (14 ms measured), so it lives briefly in the cache. */
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
 * The workspace's file list, relative to the root and sorted.
 *
 * Iterative walk on purpose: recursion with `push(...await ...)` blows the
 * stack on a deep folder and builds an intermediate array per directory.
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
  /** Path relative to the root — what the UI shows and returns when opening. */
  path: string
  name: string
  dir: string
}

/**
 * File names that contain the query.
 *
 * The ranking is what separates "found" from "found what I wanted": a name that
 * STARTS with the query comes before a name that contains it in the middle, and the exact name
 * before everything. Without this, searching for `files` returns `files.test.ts` ahead
 * of `files.ts`.
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
  /** 1-based, as the editor counts. */
  line: number
  column: number
  text: string
  length: number
}

export interface FileHits {
  path: string
  /** All occurrences in the file, even the ones that do not come back in `lines`. */
  count: number
  lines: LineHit[]
}

export interface TextSearchResult {
  occurrences: FileHits[]
  /** Text files actually read. */
  scanned: number
  matches: number
  truncated: boolean
  /** Invalid regex: it is not a search failure, it is a half-typed query. */
  invalidPattern?: boolean
}

export interface MatchOptions {
  caseSensitive?: boolean
  regex?: boolean
  /** The occurrence only counts in isolation: `file` does not match inside `walkFiles`. */
  wholeWord?: boolean
  /**
   * It inherits the format of the text found in the replacement — `File` becomes
   * `Document`, `FILE` becomes `DOCUMENT`. Without this, renaming a symbol in
   * files that use it in constants and in classes breaks the convention.
   */
  preserveCase?: boolean
}

/** Extensions worth scanning. An allow list, not a deny list: unknown binary
 *  stays out without having to open it to find out. */
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

/** Names without an extension that are text (and that the extension list does not catch). */
const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile',
  'cmakelists.txt', 'license', 'notice', 'readme',
])

/** Above this the file is a bundle, minified or data — it is not source. */
const MAX_SEARCH_BYTES = 1024 * 1024
/** How many lines of the same file come back to the UI. */
const MAX_LINES_PER_FILE = 12
/** Ceiling of occurrences counted in the whole scan. */
const MAX_MATCHES = 2_000

function isTextCandidate(relPath: string): boolean {
  const cut = relPath.lastIndexOf('/')
  const name = (cut === -1 ? relPath : relPath.slice(cut + 1)).toLowerCase()
  const dot = name.lastIndexOf('.')
  // `dot > 0` lets `.env` fall into the dotfile rule instead of becoming "no ext".
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
 * The final matcher of the search: literal query, literal with word boundary
 * or regex.
 *
 * `\b` alone would fail where the search matters most — in `snake_case` and after a
 * digit `\b` separates nothing, because `_` counts as a letter. The boundaries go
 * explicit (`\w` on the sides) so that "file" does not match in "walkFiles" nor
 * "file_2", but does match in "the file.".
 */
function buildMatcher(query: string, options: MatchOptions): RegExp | null {
  if (options.regex) return buildRegExp(query, options)
  const escaped = escapeRegExp(query)
  return buildRegExp(options.wholeWord ? `(?<!\\w)${escaped}(?!\\w)` : escaped, options)
}

/** Returns the replacement in the format of the text it is replacing. */
function applyCase(matched: string, replacement: string): string {
  if (replacement === '' || matched === '') return replacement
  const upper = matched.toUpperCase()
  const lower = matched.toLowerCase()
  // It only has case when changing the form changes the text (`123` does not).
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
 * Scans the text of the index's files for the query.
 *
 * The cost is read before it is paid: only text candidates enter, smaller than
 * 1 MB, and the function returns a PARTIAL result — the first occurrences are worth
 * more than the complete count, and the UI shows what arrived. `signal` is checked
 * on every file: a new keypress cancels the previous scan midway, instead
 * of queueing work nobody will see.
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

  // With a whole word the `indexOf` fast path does not serve — the boundary
  // has to be looked at —, so both cases go through the same matcher.
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
    // Binary disguised as text (lying extension): the NUL gives it away.
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
          // A regex that matches empty (`a*`) would enter an infinite loop.
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

  // More occurrences first: whoever looks for a symbol wants the file that talks
  // about it, not the one that cites it in passing.
  result.occurrences.sort((a, b) => b.count - a.count)
  return result
}

export interface ReplaceResult {
  files: number
  replacements: number
  /** Absolute paths written — whoever calls registers them as a manual save. */
  written: string[]
  errors: { path: string; error: string }[]
}

/**
 * Replaces in already chosen files (the search's list of occurrences).
 *
 * It writes only what changed, and only after the whole file has been read: an error
 * midway through one file leaves the others intact instead of writing half. Whoever
 * calls decides WHICH files — the scope is the UI's decision, not the engine's.
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

/** After a replacement the index has gone stale (names are the same, the
 *  content is not — but the next request may come from somewhere else). */
export function invalidateIndex(root: string): void {
  indexes.delete(root)
}
