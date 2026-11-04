import { createHash } from 'node:crypto'
import type { AppliedEdit } from '../tools/piece-common'

/**
 * Looking at a composition's file without re-reading all of it, and proving an edit landed.
 *
 * Two jobs the agent used to do badly by hand: copying an exact string out of a 500-line file
 * (it re-read the whole thing five times) and finding out whether motion_edit really changed
 * anything (it only learned at the next render). A short hash of the file travels in both
 * directions: motion_read says it, the edit receipt says before → after, and `baseHash` on the
 * next edit refuses to run on a file that is no longer the one the agent looked at.
 */

export const MAX_VIEW_LINES = 400
const MAX_MATCHES = 40

/** 8 hex chars of the file's content: enough to tell two versions apart. */
export function fileHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

export interface ViewRequest {
  from?: number
  to?: number
  /** Plain text (case-sensitive), or several: the lines that contain any of them, with context around. */
  find?: string | string[]
  context?: number
  /** A function, class, const or CSS rule by name: the WHOLE block, found and closed for you. */
  symbol?: string
}

const numbered = (lines: string[], first: number, last: number): string => {
  const width = String(last).length
  return lines
    .slice(first - 1, last)
    .map((line, i) => `${String(first + i).padStart(width)}\t${line}`)
    .join('\n')
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Lines (0-based) where a declaration of `name` begins: function, class, const/let/var, method, object member, CSS rule. */
function declarations(lines: string[], name: string): number[] {
  const n = escapeRe(name)
  const css = /^[.#[:]/.test(name) ? new RegExp(`(^|[\\s,}>+~])${n}\\s*[,{:]`) : null
  const code = [
    new RegExp(`(^|[^\\w$.])function\\s*\\*?\\s*${n}\\s*\\(`),
    new RegExp(`(^|[^\\w$.])class\\s+${n}\\b`),
    new RegExp(`(^|[^\\w$.])(const|let|var)\\s+${n}\\s*[=:;,]`),
    new RegExp(`^\\s*(async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(`^\\s*${n}\\s*:\\s*(async\\s*)?(function\\b|\\()`),
    new RegExp(`(^|[^\\w$])${n}\\s*=\\s*(async\\s*)?(function\\b|\\()`),
  ]
  const hits: number[] = []
  lines.forEach((line, i) => {
    if (css ? css.test(line) : code.some((re) => re.test(line))) hits.push(i)
  })
  return hits
}

/**
 * Last line (0-based) of the block that begins at `start`: counts { } and ignores strings,
 * template literals and comments. A declaration with no braces (an arrow const) ends at the
 * first line that closes with ";" or after a few lines. A heuristic: a regex literal with a quote
 * or a brace inside can fool it, and the answer says where it stopped.
 */
export function blockEnd(lines: string[], start: number): number {
  const limit = Math.min(lines.length, start + MAX_VIEW_LINES)
  let depth = 0
  let opened = false
  let quote: string | null = null
  let comment = false
  for (let i = start; i < limit; i++) {
    const line = lines[i]
    for (let j = 0; j < line.length; j++) {
      const c = line[j]
      const next = line[j + 1]
      if (comment) {
        if (c === '*' && next === '/') {
          comment = false
          j++
        }
        continue
      }
      if (quote) {
        if (c === '\\') j++
        else if (c === quote) quote = null
        continue
      }
      if (c === '/' && next === '/') break
      if (c === '/' && next === '*') {
        comment = true
        j++
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c
        continue
      }
      if (c === '{') {
        depth++
        opened = true
      } else if (c === '}') {
        depth--
        if (opened && depth <= 0) return i
      }
    }
    if (quote && quote !== '`') quote = null
    if (!opened && (line.trimEnd().endsWith(';') || i - start >= 6)) return i
  }
  return limit - 1
}

/**
 * What motion_read returns. No request = the file as it is (it is what edits copy from);
 * `from`/`to` = those lines, numbered; `find` = the matching lines with context, numbered.
 * Line numbers are NOT part of the file: oldText never includes them. Pure.
 */
export function viewFile(name: string, text: string, req: ViewRequest = {}): string {
  const lines = text.split('\n')
  const head = `${name} · ${lines.length} lines · hash ${fileHash(text)}`
  if (req.find === undefined && req.from === undefined && req.to === undefined && !req.symbol) return `[${head}]\n${text}`

  if (req.symbol) {
    const found = declarations(lines, req.symbol)
    if (found.length === 0) {
      return `[${head}]\nNo declaration of ${JSON.stringify(req.symbol)} (function, class, const/let/var, method or CSS rule). Try find: ${JSON.stringify(req.symbol)} to see every line that mentions it.`
    }
    const first = found[0]
    const last = blockEnd(lines, first)
    const others = found.length > 1 ? `\n(${found.length - 1} more declaration${found.length > 2 ? 's' : ''} at line${found.length > 2 ? 's' : ''} ${found.slice(1, 6).map((i) => i + 1).join(', ')})` : ''
    return `[${head}] ${JSON.stringify(req.symbol)}: lines ${first + 1}–${last + 1}; line numbers are not part of the file:\n${numbered(lines, first + 1, last + 1)}${others}`
  }

  if (req.find !== undefined) {
    const needles = (Array.isArray(req.find) ? req.find : [req.find]).filter(Boolean)
    if (needles.length === 0) return `[${head}]\nfind is empty.`
    const label = needles.map((n) => JSON.stringify(n)).join(' / ')
    const context = Math.max(0, Math.min(10, req.context ?? 2))
    const hits: number[] = []
    lines.forEach((line, i) => {
      if (needles.some((n) => line.includes(n))) hits.push(i + 1)
    })
    if (hits.length === 0) return `[${head}]\nNo line contains ${label}. (Case matters; try a shorter piece of the text.)`
    const shown = hits.slice(0, MAX_MATCHES)
    // Merge the windows around each hit so close matches read as one block.
    const blocks: Array<[number, number]> = []
    for (const hit of shown) {
      const start = Math.max(1, hit - context)
      const end = Math.min(lines.length, hit + context)
      const last = blocks[blocks.length - 1]
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
      else blocks.push([start, end])
    }
    const body = blocks.map(([a, b]) => numbered(lines, a, b)).join('\n   …\n')
    const more = hits.length > shown.length ? `\n(+${hits.length - shown.length} more matches — narrow the text)` : ''
    return `[${head}] ${hits.length} line${hits.length === 1 ? '' : 's'} contain ${label}; line numbers are not part of the file:\n${body}${more}`
  }

  const first = Math.max(1, Math.floor(req.from ?? 1))
  const requestedLast = Math.min(lines.length, Math.floor(req.to ?? lines.length))
  if (first > lines.length) return `[${head}]\nThe file has only ${lines.length} lines.`
  const last = Math.min(requestedLast, first + MAX_VIEW_LINES - 1)
  const cut = last < requestedLast ? `\n(stopped at ${MAX_VIEW_LINES} lines — ask from ${last + 1})` : ''
  return `[${head}] lines ${first}–${last}; line numbers are not part of the file:\n${numbered(lines, first, last)}${cut}`
}

/** What motion_edit answers: where each change landed and the file's hash before → after. Pure. */
export function describeEditReceipt(name: string, before: string, after: string, applied: AppliedEdit[]): string {
  const rows = applied.map((a) => {
    const times = a.replacements > 1 ? `${a.replacements} replacements, first at line ${a.line}` : `line ${a.line}`
    const size = a.oldLines === a.newLines ? '' : ` (${a.oldLines}→${a.newLines} lines)`
    return `- edit ${a.edit}: ${times}${size}${a.now ? ` — now: ${a.now}` : ''}`
  })
  const beforeLines = before.split('\n').length
  const afterLines = after.split('\n').length
  return [
    `Receipt for ${name}: ${beforeLines} → ${afterLines} lines, hash ${fileHash(before)} → ${fileHash(after)}.`,
    ...rows,
  ].join('\n')
}
