import path from 'node:path'

/**
 * Recognizes the `bash` that only READS or SEARCHES — `cat`, `sed -n`, `head`, `grep`,
 * `rg`, `find`, `ls` — so that it gets the same treatment as `read` and
 * `grep` in the context cut (context-budget.ts) and so that the tool points to the
 * symbol index when the search is for a name.
 *
 * In real data, after the code-index, 62% of the bash calls were
 * reading or searching: they went around the index and, since bash is not
 * idempotent, none of those results was discarded when repeated.
 *
 * Conservative on purpose: anything that can write (redirection,
 * `sed -i`, `find -exec`, chaining with `;`/`&&`, command substitution)
 * is not inspection. Erring toward "is not" only keeps the previous behavior.
 * Pure module, no IO.
 */

/** Commands that, alone or in a pipe among themselves, only read. */
const INSPECT_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'wc', 'grep', 'rg', 'find', 'ls', 'sort', 'uniq', 'cut', 'tr'])

/** `cd dir && ` at the start: the rest runs from `dir`. */
const LEADING_CD = /^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/

const STDERR_ONLY = /\s2>(\/dev\/null|&1)(?=\s|\||$)/g

export interface InspectCommand {
  /** Folder where the command runs, absolute */
  cwd: string
  /** The command without the leading `cd`, with normalized spaces */
  command: string
}

export interface FileView {
  /** Absolute path of the file read */
  path: string
  /** First and last line shown (1-indexed, inclusive) */
  from: number
  to: number
}

function unquote(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token.at(-1) === token[0]) {
    return token.slice(1, -1)
  }
  return token
}

/** Splits into words respecting single and double quotes. */
function words(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

/**
 * The command, when it is read/search only; null when it may have a side
 * effect or it is not possible to be sure.
 */
export function parseInspection(command: string, directory: string): InspectCommand | null {
  let rest = command.trim()
  let cwd = directory
  for (let match = LEADING_CD.exec(rest); match; match = LEADING_CD.exec(rest)) {
    cwd = path.resolve(cwd, unquote(match[1]))
    rest = rest.slice(match[0].length)
  }
  // No quotes in the middle, so the tests below do not mistake a `>` inside a
  // grep pattern for a redirection — what is left is the structure.
  // `2>/dev/null` and `2>&1` are the only accepted redirection: they only silence or
  // merge stderr, never write a file.
  const bare = rest.replace(/"[^"]*"|'[^']*'/g, '""').replace(STDERR_ONLY, '')
  if (!rest || /[;&><`\n]|\$\(/.test(bare)) return null
  for (const segment of bare.split('|')) {
    const [name, ...args] = words(segment.trim())
    if (!name || !INSPECT_COMMANDS.has(name)) return null
    if (name === 'sed' && args.some((a) => a.startsWith('-i') || a === '--in-place')) return null
    if (name === 'find' && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fls)/.test(a))) return null
  }
  return { cwd, command: rest.replace(STDERR_ONLY, '').replace(/\s+/g, ' ').trim() }
}

/**
 * The file stretch that a `cat`/`nl`/`head`/`sed -n 'A,Bp'` shows, when
 * it is a single command, over a single file. `tail` stays out: the range depends
 * on the file size, which cannot be known from here.
 */
export function parseFileView(inspection: InspectCommand): FileView | null {
  if (inspection.command.includes('|')) return null
  const [name, ...args] = words(inspection.command).map(unquote)
  const file = (value: string | undefined) =>
    value && !/[*?[\]{}~$]/.test(value) ? path.resolve(inspection.cwd, value) : null

  if (name === 'cat' || name === 'nl') {
    const files = args.filter((a) => !a.startsWith('-'))
    const target = files.length === 1 ? file(files[0]) : null
    return target ? { path: target, from: 1, to: Infinity } : null
  }
  if (name === 'head') {
    let lines = 10
    const files: string[] = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-n') lines = Number(args[++i])
      else if (/^-n\d+$/.test(arg)) lines = Number(arg.slice(2))
      else if (/^-\d+$/.test(arg)) lines = Number(arg.slice(1))
      else if (arg.startsWith('-')) return null
      else files.push(arg)
    }
    const target = files.length === 1 ? file(files[0]) : null
    return target && Number.isFinite(lines) && lines > 0 ? { path: target, from: 1, to: lines } : null
  }
  if (name === 'sed') {
    if (args.length !== 3 || args[0] !== '-n') return null
    const range = /^(\d+)(?:,(\d+))?p$/.exec(args[1])
    const target = file(args[2])
    if (!range || !target) return null
    const from = Number(range[1])
    const to = range[2] ? Number(range[2]) : from
    return from > 0 && to >= from ? { path: target, from, to } : null
  }
  return null
}

/**
 * The pattern of a `grep`/`rg` searching for a NAME (identifier, `a.b`), not
 * free text — it is the search that code_search/code_refs answer better.
 */
export function symbolSearchPattern(inspection: InspectCommand): string | null {
  const [name, ...args] = words(inspection.command.split('|')[0].trim()).map(unquote)
  if (name !== 'grep' && name !== 'rg') return null
  const pattern = args.find((a) => !a.startsWith('-'))
  if (!pattern) return null
  const bare = pattern.replace(/^\\b|\\b$/g, '')
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(bare) && bare.length >= 3 ? bare : null
}
