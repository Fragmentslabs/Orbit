/**
 * Pure helpers of the Files feature (browser, viewer, editor): names, paths, find and the
 * text edits behind the editor's keyboard accessory. No React, no native modules — all of
 * it is unit-tested.
 */

export type FileCategory =
  | 'code'
  | 'markdown'
  | 'data'
  | 'config'
  | 'text'
  | 'image'
  | 'media'
  | 'archive'
  | 'document'
  | 'other'

const BY_EXT: Record<string, FileCategory> = {}
const register = (category: FileCategory, exts: string) => {
  for (const ext of exts.split(' ')) BY_EXT[ext] = category
}
register('code', 'ts tsx js jsx mjs cjs py rb rs go java kt swift c h cpp hpp cs php sh bash zsh ps1 sql html htm css scss less vue svelte lua dart r')
register('markdown', 'md mdx markdown')
register('data', 'json jsonc csv tsv xml')
register('config', 'yml yaml toml ini env conf lock gitignore editorconfig')
register('text', 'txt log rtf')
register('image', 'png jpg jpeg gif webp avif bmp ico svg heic')
register('media', 'mp3 wav m4a aac ogg flac mp4 mov webm mkv m4v')
register('archive', 'zip tar gz tgz rar 7z')
register('document', 'pdf doc docx xls xlsx ppt pptx')

/** Lowercased extension without the dot; dotfiles (`.gitignore`) count as their own name. */
export function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot === -1) return ''
  if (dot === 0) return base.slice(1).toLowerCase()
  return base.slice(dot + 1).toLowerCase()
}

export function categoryOf(name: string): FileCategory {
  const base = (name.split('/').pop() ?? name).toLowerCase()
  if (base === 'dockerfile' || base === 'makefile') return 'code'
  return BY_EXT[extensionOf(name)] ?? 'other'
}

/** Language id for `highlightCode` (`undefined` = plain text). */
export function languageOf(name: string): string | undefined {
  const base = (name.split('/').pop() ?? name).toLowerCase()
  if (base === 'dockerfile') return 'docker'
  const ext = extensionOf(name)
  if (ext === 'jsonc') return 'json'
  if (ext === 'htm') return 'html'
  return ext || undefined
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function parentPath(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

export function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

export interface Crumb {
  name: string
  /** Path of the folder this crumb leads to ('' = the root). */
  path: string
}

export function breadcrumbs(path: string, rootName: string): Crumb[] {
  const crumbs: Crumb[] = [{ name: rootName, path: '' }]
  let acc = ''
  for (const segment of path.split('/').filter(Boolean)) {
    acc = joinPath(acc, segment)
    crumbs.push({ name: segment, path: acc })
  }
  return crumbs
}

export function lineCount(text: string): number {
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

export function longestLine(text: string): number {
  let max = 0
  let cur = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (cur > max) max = cur
      cur = 0
    } else cur++
  }
  return Math.max(max, cur)
}

// ─── Find in file ────────────────────────────────────────────────────────────

export interface FindOptions {
  caseSensitive?: boolean
}

/** Start offsets of every (non-overlapping) occurrence. Capped so a 1-char query on a big file stays cheap. */
export function findMatches(text: string, query: string, opts: FindOptions = {}, cap = 2000): number[] {
  if (!query) return []
  const hay = opts.caseSensitive ? text : text.toLowerCase()
  const needle = opts.caseSensitive ? query : query.toLowerCase()
  const out: number[] = []
  let from = 0
  while (out.length < cap) {
    const at = hay.indexOf(needle, from)
    if (at === -1) break
    out.push(at)
    from = at + needle.length
  }
  return out
}

/** 0-based line of an offset. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 0
  const end = Math.min(offset, text.length)
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** Wraps around: next(-1, 3) → 0; next(2, 3) → 0; prev(0, 3) → 2. */
export function stepIndex(current: number, total: number, dir: 1 | -1): number {
  if (total === 0) return -1
  return (current + dir + total) % total
}

// ─── Editor text edits ───────────────────────────────────────────────────────

export interface Selection {
  start: number
  end: number
}

export interface EditResult {
  text: string
  selection: Selection
}

export const INDENT = '  '

/** Tab key: inserts the indent, or indents every selected line. */
export function insertTab(text: string, sel: Selection): EditResult {
  if (sel.start === sel.end || !text.slice(sel.start, sel.end).includes('\n')) {
    const next = text.slice(0, sel.start) + INDENT + text.slice(sel.end)
    const caret = sel.start + INDENT.length
    return { text: next, selection: { start: caret, end: caret } }
  }
  const lineStart = text.lastIndexOf('\n', sel.start - 1) + 1
  const block = text.slice(lineStart, sel.end)
  const lines = block.split('\n')
  const indented = lines.map((l) => INDENT + l).join('\n')
  return {
    text: text.slice(0, lineStart) + indented + text.slice(sel.end),
    selection: { start: sel.start + INDENT.length, end: sel.end + INDENT.length * lines.length },
  }
}

/** Shift-tab: removes one indent level from every line touched by the selection. */
export function outdent(text: string, sel: Selection): EditResult {
  const lineStart = text.lastIndexOf('\n', sel.start - 1) + 1
  const block = text.slice(lineStart, sel.end)
  let removedFirst = 0
  let removedTotal = 0
  const lines = block.split('\n').map((line, i) => {
    const m = /^( {1,2}|\t)/.exec(line)
    const cut = m ? m[0].length : 0
    if (i === 0) removedFirst = cut
    removedTotal += cut
    return line.slice(cut)
  })
  return {
    text: text.slice(0, lineStart) + lines.join('\n') + text.slice(sel.end),
    selection: {
      start: Math.max(lineStart, sel.start - removedFirst),
      end: Math.max(lineStart, sel.end - removedTotal),
    },
  }
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }

/**
 * Accessory-bar insert of a bracket/quote: with a selection it wraps it, without one it
 * inserts the pair and parks the caret between. A closing character typed right before
 * the same closing character just steps over it.
 */
export function insertPair(text: string, sel: Selection, ch: string): EditResult {
  const close = PAIRS[ch]
  if (close === undefined) {
    const next = text.slice(0, sel.start) + ch + text.slice(sel.end)
    const caret = sel.start + ch.length
    return { text: next, selection: { start: caret, end: caret } }
  }
  if (sel.start !== sel.end) {
    const inner = text.slice(sel.start, sel.end)
    return {
      text: text.slice(0, sel.start) + ch + inner + close + text.slice(sel.end),
      selection: { start: sel.start + 1, end: sel.end + 1 },
    }
  }
  return {
    text: text.slice(0, sel.start) + ch + close + text.slice(sel.end),
    selection: { start: sel.start + 1, end: sel.start + 1 },
  }
}

/** Plain closing/other characters from the bar: steps over an identical next char for closers. */
export function insertChar(text: string, sel: Selection, ch: string): EditResult {
  const isCloser = ch === ')' || ch === ']' || ch === '}'
  if (isCloser && sel.start === sel.end && text[sel.start] === ch) {
    const caret = sel.start + 1
    return { text, selection: { start: caret, end: caret } }
  }
  return insertPair(text, sel, ch)
}

/**
 * Detects a newline typed by the keyboard (the new text is the old one plus exactly one
 * `\n` at the caret) and returns the auto-indented result: it copies the previous line's
 * indent and adds one level after an opening bracket. `null` = not a plain newline.
 */
export function autoIndentNewline(prev: string, next: string, caret: number): EditResult | null {
  if (next.length !== prev.length + 1 || next[caret - 1] !== '\n') return null
  if (next.slice(0, caret - 1) + next.slice(caret) !== prev) return null
  const lineStart = next.lastIndexOf('\n', caret - 2) + 1
  const prevLine = next.slice(lineStart, caret - 1)
  const indent = /^[ \t]*/.exec(prevLine)?.[0] ?? ''
  const opens = /[{([]\s*$/.test(prevLine)
  const insert = indent + (opens ? INDENT : '')
  if (!insert) return null
  const out = next.slice(0, caret) + insert + next.slice(caret)
  const c = caret + insert.length
  return { text: out, selection: { start: c, end: c } }
}

// ─── Highlight per line ──────────────────────────────────────────────────────

export interface LineToken {
  text: string
  color?: string
}

/**
 * Splits highlighted tokens (which may span lines, like block comments) into one token
 * list per line, so a virtualized list can render a line at a time.
 */
export function splitTokensByLine(tokens: LineToken[]): LineToken[][] {
  const lines: LineToken[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) lines[lines.length - 1].push({ text: part, color: token.color })
    })
  }
  return lines
}

/** Above this the viewer skips highlighting: the regex pass would stall the JS thread. */
export const HIGHLIGHT_MAX_CHARS = 200_000
